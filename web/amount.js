// Exact decimal formatting for on-chain raw u128 amounts. BigInt only: no Number anywhere,
// so values above 2^53 stay exact. docs/STABLECOIN.md section 10.

const MAX_DECIMALS = 36;

function checkDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`decimals must be an integer 0..=${MAX_DECIMALS}, got ${String(decimals)}`);
  }
}

function toBigInt(raw) {
  if (typeof raw === 'bigint') {
    if (raw < 0n) throw new Error('amount must not be negative');
    return raw;
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) throw new Error(`unsafe amount: ${raw}`);
    return BigInt(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  throw new Error(`amount must be a non-negative integer string or bigint, got ${JSON.stringify(raw)}`);
}

/** `4000000`, 6 -> "4"; `1` -> "0.000001"; trailing zeros removed. */
export function formatAmount(raw, decimals, { maxFraction = decimals } = {}) {
  checkDecimals(decimals);
  if (!Number.isInteger(maxFraction) || maxFraction < 0 || maxFraction > decimals) {
    throw new Error(`maxFraction must be an integer 0..=${decimals}`);
  }
  const value = toBigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  let fraction = (value % base).toString().padStart(decimals, '0');
  fraction = fraction.slice(0, maxFraction).replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** "1.5", 6 -> 1500000n. Strict: no sign, no exponent, no whitespace, no hex. */
export function parseAmount(text, decimals) {
  checkDecimals(decimals);
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) {
    throw new Error('amount must look like 123 or 123.45');
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
