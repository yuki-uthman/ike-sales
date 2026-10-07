// MVR amounts. MVR has exactly two decimals (laari), so the store keeps integer
// laari and day totals stay exact where REAL would drift (decision 6).
// Pure: knows nothing of HTTP or D1.

const MVR_TEXT = /^\d+(\.\d{1,2})?$/;

/**
 * Parse an amount as it arrives in the HTTP contract — MVR as a JSON string, or
 * a JSON number whose decimal text matches the same shape — into integer laari.
 * Returns null unless the value is a positive two-decimal MVR number.
 */
export function parseMvrToLaari(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const text = typeof value === 'string' ? value : String(value);
  if (!MVR_TEXT.test(text)) return null;

  const [whole, frac = ''] = text.split('.');
  const laari = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(laari) || laari <= 0) return null;
  return laari;
}

/** Render integer laari as MVR with two decimals, the contract's `amount_mvr`. */
export function formatLaariAsMvr(laari) {
  const whole = Math.floor(laari / 100);
  const frac = laari % 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}
