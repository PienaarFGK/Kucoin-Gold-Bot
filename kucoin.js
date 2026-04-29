/**
 * KuCoin Futures API client — XAUTUSDTM (Gold Perpetual)
 * Auth: HMAC-SHA256, API Key Version 2
 */

import crypto from "crypto";

const BASE_URL = "https://api-futures.kucoin.com";
export const SYMBOL = "XAUTUSDTM";

// ── Auth ───────────────────────────────────────────────────────────────────────

function sign(secret, str) {
  return crypto.createHmac("sha256", secret).update(str).digest("base64");
}

async function request(method, endpoint, body = null) {
  const ts    = Date.now().toString();
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
  if (json.code !== "200000") {
    throw new Error(`KuCoin [${json.code}]: ${json.msg ?? JSON.stringify(json)}`);
  }
  return json.data;
}

// ── Contract cache ─────────────────────────────────────────────────────────────

let _contractInfo = null;

export async function loadContractInfo() {
  const data = await request("GET", `/api/v1/contracts/${SYMBOL}`);
  _contractInfo = data;
  console.log(` Contract loaded — multiplier: ${data?.multiplier}  lotSize: ${data?.lotSize}  tickSize: ${data?.tickSize}`);
  return data;
}

export function getMinLotSize() {
  return parseFloat(_contractInfo?.lotSize ?? 1);
}

// ── Market data ────────────────────────────────────────────────────────────────

export async function getLivePrice() {
  try {
    const data = await request("GET", `/api/v1/ticker?symbol=${SYMBOL}`);
    return parseFloat(data?.price ?? 0);
  } catch {
    return 0;
  }
}

// ── Price rounding ─────────────────────────────────────────────────────────────

export function roundPrice(price) {
  const tickSize = parseFloat(_contractInfo?.tickSize ?? 0.01);
  const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
  return parseFloat(price.toFixed(decimals));
}

// ── Quantity helpers ───────────────────────────────────────────────────────────

/**
 * Calculate number of lots for a given USDT trade size.
 * contractValue (USDT per lot) = multiplier × price
 */
export function calcLots(tradeUsd, leverage, price) {
  const multiplier = parseFloat(_contractInfo?.multiplier ?? 0.001);
  const lotSize    = parseFloat(_contractInfo?.lotSize    ?? 1);
  const contractValue = multiplier * price;
  const rawLots = (tradeUsd * leverage) / contractValue;
  const lots    = Math.floor(rawLots / lotSize) * lotSize;
  if (lots < lotSize) {
    throw new Error(`Lots ${lots} below minimum ${lotSize} — increase TRADE_SIZE_USD`);
  }
  return lots;
}

export function splitLots(totalLots) {
  const lotSize = getMinLotSize();
  const lots1 = Math.floor(totalLots * 0.70 / lotSize) * lotSize;
  const lots2 = Math.floor(totalLots * 0.30 / lotSize) * lotSize;
  return { lots1, lots2 };
}

// ── Orders ─────────────────────────────────────────────────────────────────────

/**
 * Place an entry order (limit or market).
 */
export async function placeOrder({ side, type, price, size, leverage }) {
  const body = {
    clientOid: `gold_${Date.now()}`,
    side,           // "buy" | "sell"
    symbol: SYMBOL,
    type,           // "limit" | "market"
    leverage: String(leverage),
    size,
    ...(type === "limit" ? { price: String(price), timeInForce: "GTC" } : {}),
  };
  return request("POST", "/api/v1/orders", body);
}

/**
 * Get order status. Returns "FILLED" | "OPEN" | "CANCELLED".
 */
export async function getOrderStatus(orderId) {
  const data = await request("GET", `/api/v1/orders/${orderId}`);
  if (data?.status === "done" && parseInt(data?.filledSize) === parseInt(data?.size)) return "FILLED";
  if (data?.status === "done") return "CANCELLED";
  return "OPEN";
}

/**
 * Place a stop order (SL or TP) that closes part or all of a position.
 *
 * stop: "down" → triggers when price falls to stopPrice (SL for LONG, TP for SHORT)
 *       "up"   → triggers when price rises to stopPrice (TP for LONG, SL for SHORT)
 */
export async function placeStopOrder({ side, stop, stopPrice, size }) {
  const data = await request("POST", "/api/v1/stopOrders", {
    clientOid:     `gold_stop_${Date.now()}`,
    side,
    symbol:        SYMBOL,
    type:          "market",
    stop,
    stopPriceType: "TP",    // last trade price
    stopPrice:     String(roundPrice(stopPrice)),
    size,
    reduceOnly:    true,
  });
  console.log(`  placeStopOrder raw: ${JSON.stringify(data)}`);
  return data?.orderId ?? null;
}

/**
 * Cancel a stop order. Returns true on success.
 */
export async function cancelStopOrder(orderId) {
  try {
    await request("DELETE", `/api/v1/stopOrders/${orderId}`);
    return true;
  } catch (err) {
    console.warn(`  cancelStopOrder ${orderId} failed: ${err.message}`);
    return false;
  }
}

/**
 * Close the entire position at market.
 * closeSide: "sell" to close a long, "buy" to close a short.
 */
export async function closePosition(closeSide) {
  return request("POST", "/api/v1/orders", {
    clientOid:  `gold_close_${Date.now()}`,
    side:       closeSide,
    symbol:     SYMBOL,
    type:       "market",
    closeOrder: true,
  });
}

/**
 * Returns the current open position for SYMBOL, or null if flat.
 */
export async function getPosition() {
  try {
    const data = await request("GET", `/api/v1/position?symbol=${SYMBOL}`);
    return data?.isOpen ? data : null;
  } catch {
    return null;
  }
}
