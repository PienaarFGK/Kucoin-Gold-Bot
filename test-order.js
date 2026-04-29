/**
 * KuCoin Futures API test — places a BUY LIMIT order for XAUTUSDTM far below
 * market price (so it won't fill), then cancels it immediately.
 *
 * Run: node test-order.js
 */

import "dotenv/config";
import crypto from "crypto";

const BASE_URL = "https://api-futures.kucoin.com";
const SYMBOL   = "XAUTUSDTM";

function sign(secret, str) {
  return crypto.createHmac("sha256", secret).update(str).digest("base64");
}

async function request(method, endpoint, body = null) {
  const ts      = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const secret  = process.env.KUCOIN_SECRET_KEY;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: {
      "KC-API-KEY":         process.env.KUCOIN_API_KEY,
      "KC-API-SIGN":        sign(secret, ts + method + endpoint + bodyStr),
      "KC-API-TIMESTAMP":   ts,
      "KC-API-PASSPHRASE":  sign(secret, process.env.KUCOIN_PASSPHRASE),
      "KC-API-KEY-VERSION": "2",
      "Content-Type":       "application/json",
    },
    body: bodyStr || undefined,
  });

  const json = await res.json();
  return json;
}

async function main() {
  console.log("\n KuCoin Futures API Test\n");

  // ── Step 1: Contract info ──────────────────────────────────────────────────
  console.log(" Step 1: Fetching contract info…");
  const contractRes = await request("GET", `/api/v1/contracts/${SYMBOL}`);
  if (contractRes.code !== "200000") {
    console.error(" Contract info failed:", JSON.stringify(contractRes));
    return;
  }
  const info = contractRes.data;
  console.log(`  Symbol:     ${info.symbol}`);
  console.log(`  Multiplier: ${info.multiplier}`);
  console.log(`  Lot size:   ${info.lotSize}`);
  console.log(`  Tick size:  ${info.tickSize}`);

  // ── Step 2: Live price ─────────────────────────────────────────────────────
  console.log("\n Step 2: Fetching live price…");
  const tickerRes = await request("GET", `/api/v1/ticker?symbol=${SYMBOL}`);
  if (tickerRes.code !== "200000") {
    console.error(" Ticker failed:", JSON.stringify(tickerRes));
    return;
  }
  const livePrice = parseFloat(tickerRes.data.price);
  console.log(`  Live price: ${livePrice}`);

  // ── Step 3: Place limit order 20% below market ─────────────────────────────
  const tickSize   = parseFloat(info.tickSize ?? 0.1);
  const decimals   = Math.max(0, Math.round(-Math.log10(tickSize)));
  const testPrice  = parseFloat((livePrice * 0.80).toFixed(decimals));
  const lotSize    = parseFloat(info.lotSize ?? 1);
  const multiplier = parseFloat(info.multiplier ?? 0.001);

  // Calculate lots for $10 × 2x at test price
  const lots = Math.max(lotSize, Math.floor((10 * 2) / (multiplier * testPrice) / lotSize) * lotSize);

  // ── Step 3a: Set margin mode to ISOLATED ────────────────────────────────────
  console.log("\n Step 3a: Setting margin mode to ISOLATED…");
  const marginRes = await request("POST", "/api/v1/position/margin/auto-deposit-status", {
    symbol: SYMBOL,
    status: false,   // false = isolated (no auto top-up), true = cross-like auto-deposit
  });
  console.log(" Margin mode response:", JSON.stringify(marginRes));

  console.log(`\n Step 3b: Placing BUY LIMIT at ${testPrice} (20% below market), ${lots} lot(s)…`);
  const orderRes = await request("POST", "/api/v1/orders", {
    clientOid:  `test_${Date.now()}`,
    side:       "buy",
    symbol:     SYMBOL,
    type:       "limit",
    leverage:   "2",
    size:       lots,
    price:      String(testPrice),
    timeInForce: "GTC",
  });
  console.log(" Order response:", JSON.stringify(orderRes, null, 2));

  const orderId = orderRes?.data?.orderId;

  // ── Step 4: Cancel immediately ─────────────────────────────────────────────
  if (orderId) {
    console.log(`\n Step 4: Cancelling order ${orderId}…`);
    const cancelRes = await request("DELETE", `/api/v1/orders/${orderId}`);
    console.log(" Cancel response:", JSON.stringify(cancelRes, null, 2));
    console.log("\n Test complete — order placed and cancelled successfully!");
    console.log(` Multiplier: ${multiplier}  →  $10 × 2x @ ${testPrice} = ${lots} lot(s)`);
  } else {
    console.log("\n No orderId returned — check the order response above for errors.");
  }
}

main().catch(console.error);
