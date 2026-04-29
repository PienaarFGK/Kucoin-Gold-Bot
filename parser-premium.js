/**
 * Parser for "PREMIUM SIGNAL & EDUCATION FOREX TRADING WIZARD" messages.
 *
 * Initial signal:
 *   XAUUSD SELL BY MARKET @4697.63 SL@4705.04 TP@4680.73
 *
 * Follow-up messages:
 *   SET SL@4705.89
 *   MOVE SL@4696.00 TO SECURE SOME PROFIT !!
 *   take profit now
 */

export function parsePremiumMessage(text) {
  const t = text.trim();

  // ── Close now ──────────────────────────────────────────────────────────────
  // Matches: "take profit now", "close profit now", "close proift now" (typo),
  //          "close all", "close position", "close now"
  if (/take\s*profit\s*now|close\b.*\bnow\b|close\s*(all|position|profit)/i.test(t)) {
    return { type: "closeNow" };
  }

  // ── Move / Set SL ──────────────────────────────────────────────────────────
  // "SET SL@4705.89" or "MOVE SL@4696.00 ..."
  const slMatch = t.match(/(?:set|move)\s+sl@([\d.]+)/i);
  if (slMatch) {
    return { type: "setSL", price: parseFloat(slMatch[1]) };
  }

  // ── Initial signal ─────────────────────────────────────────────────────────
  // Handles typos like "XAUUSE", "XAUUSD", "XAU/USD"
  // Handles "SELL AGAIN", "BUY AGAIN" etc.
  const sigMatch = t.match(
    /xau[\w\/]*\s+(buy|sell)\b.*?@([\d.]+)\s+sl@([\d.]+)\s+tp@([\d.]+)/i
  );
  if (sigMatch) {
    const isBuy = /buy/i.test(sigMatch[1]);
    return {
      type:  "signal",
      side:  isBuy ? "buy" : "sell",
      entry: parseFloat(sigMatch[2]),
      stop:  parseFloat(sigMatch[3]),
      tp:    parseFloat(sigMatch[4]),
    };
  }

  return null; // non-actionable message — ignore
}
