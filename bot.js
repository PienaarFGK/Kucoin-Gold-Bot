/**
 * KuCoin Gold Bot
 *
 * Monitors two Telegram groups and trades XAUTUSDT Perpetual on KuCoin:
 *
 *  "VIP Gold Trader Alliance"
 *    → LIMIT orders, 70/30 TP split, two-phase SL monitor
 *
 *  "PREMIUM SIGNAL & EDUCATION FOREX TRADING WIZARD"
 *    → MARKET orders (only if SL + TP place immediately after)
 *    → Handles follow-ups: SET SL, MOVE SL, take profit now
 *
 * First run: copy .env.example → .env, fill credentials, then: node bot.js
 */

import "dotenv/config";
import http from "http";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { createInterface } from "readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

import { parseVipSignal }      from "./parser-vip.js";
import { parsePremiumMessage } from "./parser-premium.js";
import {
  loadContractInfo, getLivePrice, calcLots, splitLots,
  roundPrice, getMinLotSize, placeOrder, getOrderStatus,
  placeStopOrder, cancelStopOrder, closePosition, getPosition,
} from "./kucoin.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const TRADE_SIZE_USD = parseFloat(process.env.TRADE_SIZE_USD ?? "10");
const LEVERAGE       = parseFloat(process.env.LEVERAGE       ?? "2");
const PAPER_TRADING  = process.env.PAPER_TRADING !== "false";
const POLL_INTERVAL  = 30_000;
const LOG_FILE       = "trades.log";
const SESSION_FILE   = "session.txt";

const VIP_GROUP     = "VIP Gold Trader Alliance";
const PREMIUM_GROUP = "PREMIUM SIGNAL & EDUCATION FOREX TRADING WIZARD";

// ── State ──────────────────────────────────────────────────────────────────────

// VIP monitors: orderId → { phase, side, closeSide, entry, stop, tp1, tp2,
//                           totalLots, lots1, lots2, hasTP2,
//                           slOrderId, tp1OrderId, tp2OrderId }
const pendingVipMonitors = new Map();

// PREMIUM active position (one at a time)
// { side, closeSide, lots, entry, slOrderId, tpOrderId }
let premiumPosition = null;

const processedMsgIds = new Set();

// ── Helpers ────────────────────────────────────────────────────────────────────

function logTrade(entry) {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function checkEnv() {
  const required = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_PHONE"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { console.error(`\n Missing: ${missing.join(", ")}`); process.exit(1); }
  if (!PAPER_TRADING) {
    const km = ["KUCOIN_API_KEY", "KUCOIN_SECRET_KEY", "KUCOIN_PASSPHRASE"].filter(k => !process.env[k]);
    if (km.length) { console.error(`\n Live mode requires: ${km.join(", ")}`); process.exit(1); }
  }
}

// ── VIP Signal handler ─────────────────────────────────────────────────────────

async function handleVipSignal(text) {
  const signal = parseVipSignal(text);
  if (!signal) return;

  const { side, entry, stop, tp1, tp2 } = signal;
  const closeSide = side === "buy" ? "sell" : "buy";

  const livePrice = await getLivePrice();
  console.log(`\n [VIP] ${side.toUpperCase()} XAUT`);
  console.log(`  Entry: ${entry}  Stop: ${stop}  TP1: ${tp1}${tp2 ? `  TP2: ${tp2}` : ""}  (live: ${livePrice})`);

  if (PAPER_TRADING) {
    logTrade({ mode: "paper", group: "VIP", side, entry, stop, tp1, tp2 });
    console.log("  [PAPER] Logged only — PAPER_TRADING=true");
    return;
  }

  let totalLots;
  try {
    totalLots = calcLots(TRADE_SIZE_USD, LEVERAGE, entry);
  } catch (err) {
    console.error(`  Qty error: ${err.message}`);
    return;
  }

  const { lots1, lots2 } = splitLots(totalLots);
  const hasTP2 = !!(tp2 && lots2 >= getMinLotSize());

  console.log(hasTP2
    ? `  Lots: ${totalLots} → ${lots1} (70% TP1) + ${lots2} (30% TP2)`
    : `  Lots: ${totalLots} (single — no TP2 or lots2 below minimum)`
  );

  let order;
  try {
    order = await placeOrder({ side, type: "limit", price: roundPrice(entry), size: totalLots, leverage: LEVERAGE });
    console.log(`  Limit order placed ✓  orderId: ${order?.orderId}`);
    logTrade({ mode: "live", group: "VIP", status: "placed", side, entry, stop, tp1, tp2, lots: totalLots, orderId: order?.orderId });
  } catch (err) {
    console.error(`  Order failed: ${err.message}`);
    logTrade({ mode: "live", group: "VIP", status: "failed", side, entry, error: err.message });
    return;
  }

  pendingVipMonitors.set(order.orderId, {
    phase: "WAITING_FILL",
    side, closeSide,
    entry: roundPrice(entry), stop, tp1, tp2,
    totalLots, lots1, lots2, hasTP2,
    slOrderId: null, tp1OrderId: null, tp2OrderId: null,
  });
  console.log(`  Monitoring order ${order.orderId}…`);
}

// ── VIP Monitor tick ───────────────────────────────────────────────────────────

async function vipMonitorTick(orderId, info) {
  try {
    // Phase 1: wait for limit order to fill
    if (info.phase === "WAITING_FILL") {
      const status = await getOrderStatus(orderId);
      if (status !== "FILLED") return;

      console.log(`\n [VIP] Order filled — placing stops`);
      const { side, closeSide, stop, tp1, tp2, totalLots, lots1, lots2, hasTP2 } = info;

      const stopDir = side === "buy" ? "down" : "up";
      const tpDir   = side === "buy" ? "up"   : "down";

      // SL for full position
      info.slOrderId = await placeStopOrder({ side: closeSide, stop: stopDir, stopPrice: stop, size: totalLots });
      console.log(`  SL placed ✓  (${stop})  condId: ${info.slOrderId}`);

      if (hasTP2) {
        info.tp1OrderId = await placeStopOrder({ side: closeSide, stop: tpDir, stopPrice: tp1, size: lots1 });
        console.log(`  TP1 placed ✓  (${tp1})  condId: ${info.tp1OrderId}`);
        info.tp2OrderId = await placeStopOrder({ side: closeSide, stop: tpDir, stopPrice: tp2, size: lots2 });
        console.log(`  TP2 placed ✓  (${tp2})  condId: ${info.tp2OrderId}`);
        info.phase = "WAITING_TP1";
      } else {
        info.tp1OrderId = await placeStopOrder({ side: closeSide, stop: tpDir, stopPrice: tp1, size: totalLots });
        console.log(`  TP placed ✓  (${tp1})  condId: ${info.tp1OrderId}`);
        pendingVipMonitors.delete(orderId); // single TP — nothing more to track
      }
      logTrade({ mode: "live", group: "VIP", status: "stops_placed", slOrderId: info.slOrderId });
      return;
    }

    // Phase 2: wait for TP1 to fire (position size drops to ≈ lots2)
    if (info.phase === "WAITING_TP1") {
      const pos = await getPosition();
      const currentLots = pos ? Math.abs(parseInt(pos.currentQty ?? 0)) : 0;

      if (currentLots >= info.totalLots) return; // unchanged — TP1 not yet hit

      if (currentLots === 0) {
        // Position fully closed (SL hit or both TPs fired)
        console.log(`\n [VIP] Position closed for ${orderId}`);
        pendingVipMonitors.delete(orderId);
        return;
      }

      // Position partially reduced — TP1 fired
      console.log(`\n [VIP] TP1 fired — moving SL to entry (${info.entry})`);
      pendingVipMonitors.delete(orderId);

      if (info.slOrderId) await cancelStopOrder(info.slOrderId);

      const newSlId = await placeStopOrder({
        side:      info.closeSide,
        stop:      info.side === "buy" ? "down" : "up",
        stopPrice: info.entry,
        size:      info.lots2,
      });
      console.log(`  SL moved to entry ✓  condId: ${newSlId}`);
      logTrade({ mode: "live", group: "VIP", status: "sl_moved_to_entry", entry: info.entry, condId: newSlId });
    }
  } catch (err) {
    console.warn(`  VIP monitor error [${orderId}]: ${err.message}`);
  }
}

// ── PREMIUM Message handler ────────────────────────────────────────────────────

async function handlePremiumMessage(text) {
  const parsed = parsePremiumMessage(text);
  if (!parsed) return;

  console.log(`\n [PREMIUM] ${parsed.type} ${JSON.stringify(parsed)}`);

  if (PAPER_TRADING) {
    logTrade({ mode: "paper", group: "PREMIUM", ...parsed });
    console.log("  [PAPER] Logged only — PAPER_TRADING=true");
    return;
  }

  // ── Close now ────────────────────────────────────────────────────────────────
  if (parsed.type === "closeNow") {
    if (!premiumPosition) { console.log("  No active PREMIUM position to close"); return; }
    try {
      if (premiumPosition.slOrderId) await cancelStopOrder(premiumPosition.slOrderId);
      if (premiumPosition.tpOrderId) await cancelStopOrder(premiumPosition.tpOrderId);
      await closePosition(premiumPosition.closeSide);
      console.log("  Position closed at market ✓");
      logTrade({ mode: "live", group: "PREMIUM", status: "closed_at_market" });
      premiumPosition = null;
    } catch (err) {
      console.error(`  Close failed: ${err.message}`);
    }
    return;
  }

  // ── Move / Set SL ────────────────────────────────────────────────────────────
  if (parsed.type === "setSL") {
    if (!premiumPosition) { console.log("  No active PREMIUM position for SL move"); return; }
    try {
      if (premiumPosition.slOrderId) await cancelStopOrder(premiumPosition.slOrderId);
      const newSlId = await placeStopOrder({
        side:      premiumPosition.closeSide,
        stop:      premiumPosition.side === "buy" ? "down" : "up",
        stopPrice: parsed.price,
        size:      premiumPosition.lots,
      });
      premiumPosition.slOrderId = newSlId;
      console.log(`  SL moved to ${parsed.price} ✓  condId: ${newSlId}`);
      logTrade({ mode: "live", group: "PREMIUM", status: "sl_moved", price: parsed.price, condId: newSlId });
    } catch (err) {
      console.error(`  SL move failed: ${err.message}`);
    }
    return;
  }

  // ── New signal ────────────────────────────────────────────────────────────────
  if (parsed.type === "signal") {
    if (premiumPosition) {
      console.log("  Active PREMIUM position already open — skipping new signal");
      return;
    }

    const { side, entry, stop, tp } = parsed;
    const closeSide = side === "buy" ? "sell" : "buy";
    const stopDir   = side === "buy" ? "down" : "up";
    const tpDir     = side === "buy" ? "up"   : "down";

    const livePrice = await getLivePrice();
    console.log(`  ${side.toUpperCase()} XAUT @ market  Entry≈${entry}  Stop: ${stop}  TP: ${tp}  (live: ${livePrice})`);

    let lots;
    try {
      lots = calcLots(TRADE_SIZE_USD, LEVERAGE, livePrice || entry);
    } catch (err) {
      console.error(`  Qty error: ${err.message}`);
      return;
    }
    console.log(`  Lots: ${lots}`);

    // ── Step 1: Place market order ──────────────────────────────────────────
    let order;
    try {
      order = await placeOrder({ side, type: "market", size: lots, leverage: LEVERAGE });
      console.log(`  Market order placed ✓  orderId: ${order?.orderId}`);
    } catch (err) {
      console.error(`  Market order failed: ${err.message}`);
      return;
    }

    // ── Step 2: Place SL immediately — if it fails, close position ──────────
    let slOrderId = null;
    try {
      slOrderId = await placeStopOrder({ side: closeSide, stop: stopDir, stopPrice: stop, size: lots });
      console.log(`  SL placed ✓  (${stop})  condId: ${slOrderId}`);
    } catch (err) {
      console.error(`  SL failed — closing position for safety: ${err.message}`);
      await closePosition(closeSide).catch(e => console.error(`  Close also failed: ${e.message}`));
      logTrade({ mode: "live", group: "PREMIUM", status: "aborted_no_sl", side, entry, error: err.message });
      return;
    }

    // ── Step 3: Place TP — if it fails, SL still protects the position ──────
    let tpOrderId = null;
    try {
      tpOrderId = await placeStopOrder({ side: closeSide, stop: tpDir, stopPrice: tp, size: lots });
      console.log(`  TP placed ✓  (${tp})  condId: ${tpOrderId}`);
    } catch (err) {
      console.warn(`  TP failed (SL still active — set TP manually): ${err.message}`);
    }

    premiumPosition = { side, closeSide, lots, entry, slOrderId, tpOrderId };
    logTrade({ mode: "live", group: "PREMIUM", status: "placed", side, entry, stop, tp, lots, slOrderId, tpOrderId });
  }
}

// ── Polling loop ───────────────────────────────────────────────────────────────

function startMonitorLoop() {
  setInterval(async () => {
    for (const [orderId, info] of pendingVipMonitors) {
      await vipMonitorTick(orderId, info);
    }
  }, POLL_INTERVAL);
}

// ── Telegram auth prompt ───────────────────────────────────────────────────────

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  checkEnv();

  console.log(`\n KuCoin Gold Bot`);
  console.log(`  Mode:     ${PAPER_TRADING ? "PAPER (no real orders)" : "LIVE"}`);
  console.log(`  Trade:    $${TRADE_SIZE_USD} × ${LEVERAGE}x leverage`);
  console.log(`  Groups:   ${VIP_GROUP}`);
  console.log(`            ${PREMIUM_GROUP}\n`);

  if (!PAPER_TRADING) await loadContractInfo();

  const sessionStr = process.env.TELEGRAM_SESSION
    ?? (existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : "");

  const client = new TelegramClient(
    new StringSession(sessionStr),
    parseInt(process.env.TELEGRAM_API_ID, 10),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: () => process.env.TELEGRAM_PHONE,
    password:    () => prompt("Telegram 2FA password (Enter if none): "),
    phoneCode:   () => prompt("Enter the Telegram code: "),
    onError:     err => console.error("Auth error:", err),
  });

  const savedSession = client.session.save();
  writeFileSync(SESSION_FILE, savedSession);
  console.log(" Connected to Telegram. Listening for signals…");
  console.log(` Session saved. For Railway:\n  TELEGRAM_SESSION=${savedSession}\n`);

  startMonitorLoop();

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg?.text) return;
    if (processedMsgIds.has(msg.id)) return;
    processedMsgIds.add(msg.id);

    let chatTitle;
    try {
      const chat = await msg.getChat();
      chatTitle = chat?.title ?? "";
    } catch { return; }

    console.log(`\n── [${chatTitle}] ──────────────────────`);
    console.log(msg.text);
    console.log("────────────────────────────────────────");

    if (chatTitle.includes("Gold Trader Alliance")) {
      await handleVipSignal(msg.text);
    } else if (chatTitle.includes("PREMIUM SIGNAL") && chatTitle.includes("FOREX TRADING WIZARD")) {
      await handlePremiumMessage(msg.text);
    }
  }, new NewMessage({}));

  // Health check — keeps Railway container alive
  const PORT = process.env.PORT || 3000;
  http.createServer((_, res) => res.end("Gold Bot running")).listen(PORT, () => {
    console.log(` Health check on port ${PORT}`);
  });

  await new Promise(() => {});
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
