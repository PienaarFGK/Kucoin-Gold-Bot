/**
 * Parser for "VIP Gold Trader Alliance" signals.
 *
 * Expected format:
 *   🪙 XAU/USD Buy 4515 - 4512
 *   🚀 Stoploss : 4507
 *   - Take Profit : 4522 ( 100pips )
 *   - Take Profit : 4645 ( 450pips )
 */

export function parseVipSignal(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // ── Direction + entry ──────────────────────────────────────────────────────
  // Find line containing XAU and Buy or Sell
  const dirLine = lines.find(l => /xau/i.test(l) && /\b(buy|sell)\b/i.test(l));
  if (!dirLine) return null;

  const isBuy = /\bbuy\b/i.test(dirLine);

  // Entry zone: "4515 - 4512" or single price "4515"
  const rangeMatch = dirLine.match(/([\d]+\.?\d*)\s*[-–]\s*([\d]+\.?\d*)/);
  let entry;
  if (rangeMatch) {
    const p1 = parseFloat(rangeMatch[1]);
    const p2 = parseFloat(rangeMatch[2]);
    // Use better price for direction: lower for BUY, higher for SELL
    entry = isBuy ? Math.min(p1, p2) : Math.max(p1, p2);
  } else {
    // Single price on the direction line
    const nums = [...dirLine.matchAll(/[\d]+\.?\d*/g)].map(m => parseFloat(m[0])).filter(n => n > 100);
    if (!nums.length) return null;
    entry = nums[0];
  }

  // ── Stop loss ──────────────────────────────────────────────────────────────
  const stopLine = lines.find(l => /stoploss|stop\s*loss/i.test(l));
  if (!stopLine) return null;
  const stopNums = [...stopLine.matchAll(/[\d]+\.?\d*/g)].map(m => parseFloat(m[0])).filter(n => n > 100);
  if (!stopNums.length) return null;
  const stop = stopNums[0];

  // ── Take profits ───────────────────────────────────────────────────────────
  const tpLines = lines.filter(l => /take\s*profit/i.test(l));
  const tps = tpLines.map(l => {
    const nums = [...l.matchAll(/[\d]+\.?\d*/g)].map(m => parseFloat(m[0])).filter(n => n > 100);
    return nums[0] ?? null;
  }).filter(Boolean);

  if (!tps.length) return null;

  return {
    side:  isBuy ? "buy" : "sell",
    entry,
    stop,
    tp1: tps[0],
    tp2: tps[1] ?? null,
  };
}
