/**
 * Money is always handled as integer minor units (e.g. cents) inside the domain
 * so that fee/commission arithmetic is exact. The database stores NUMERIC(12,2)
 * per spec §D; conversion happens only at the persistence/API boundary.
 *
 * Currency is never hard-coded (spec §0 / §B.3): every Money carries its code.
 */

export interface Money {
  /** Integer amount in the currency's minor unit (MUR: cents). */
  readonly minor: number;
  /** ISO-4217 currency code, e.g. "MUR". */
  readonly currency: string;
}

/** Minor-unit exponent per currency. Unknown currencies default to 2. */
const EXPONENTS: Record<string, number> = {
  MUR: 2, USD: 2, EUR: 2, GBP: 2, ZAR: 2, INR: 2, KES: 2,
  JPY: 0, KRW: 0, XOF: 0, XAF: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

export class MoneyError extends Error {}

function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`${label} must be a safe integer, got ${n}`);
}

export function money(minor: number, currency: string): Money {
  assertInt(minor, 'minor');
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`Invalid currency code: ${currency}`);
  return Object.freeze({ minor, currency });
}

/** Parse a decimal string/number in major units ("1250.50") to Money without float drift. */
export function fromMajor(amount: string | number, currency: string): Money {
  const exp = currencyExponent(currency);
  const s = typeof amount === 'number' ? amount.toFixed(exp) : amount.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyError(`Invalid amount: ${amount}`);
  const [, neg, whole, fracRaw = ''] = m;
  if (fracRaw.length > exp && /[1-9]/.test(fracRaw.slice(exp))) {
    throw new MoneyError(`Amount ${amount} has more precision than ${currency} allows`);
  }
  const frac = (fracRaw + '0'.repeat(exp)).slice(0, exp);
  const minor = Number(whole) * 10 ** exp + (exp ? Number(frac) : 0);
  return money(neg ? -minor : minor, currency);
}

/** Format to a decimal string in major units, suitable for NUMERIC columns and gateway APIs. */
export function toMajorString(m: Money): string {
  const exp = currencyExponent(m.currency);
  const neg = m.minor < 0;
  const abs = Math.abs(m.minor);
  if (exp === 0) return `${neg ? '-' : ''}${abs}`;
  const s = abs.toString().padStart(exp + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money { sameCurrency(a, b); return money(a.minor + b.minor, a.currency); }
export function sub(a: Money, b: Money): Money { sameCurrency(a, b); return money(a.minor - b.minor, a.currency); }
export function isZero(a: Money): boolean { return a.minor === 0; }
export function isPositive(a: Money): boolean { return a.minor > 0; }
export function eq(a: Money, b: Money): boolean { return a.currency === b.currency && a.minor === b.minor; }
export function gt(a: Money, b: Money): boolean { sameCurrency(a, b); return a.minor > b.minor; }
export function zero(currency: string): Money { return money(0, currency); }

/**
 * Multiply by a percentage expressed in basis points (1500 bps = 15.00%).
 * Uses round-half-up on the absolute value (commercial rounding), which is
 * what finance teams expect on invoices. Basis points avoid float percentages.
 */
export function percentOf(a: Money, basisPoints: number): Money {
  assertInt(basisPoints, 'basisPoints');
  const sign = a.minor < 0 ? -1 : 1;
  const product = Math.abs(a.minor) * basisPoints; // safe: 1e12 minor * 1e4 bps < 2^53 only up to ~9e11; guard below
  if (!Number.isSafeInteger(product)) throw new MoneyError('Amount too large for percentage computation');
  const q = Math.floor(product / 10_000);
  const r = product % 10_000;
  return money(sign * (r * 2 >= 10_000 ? q + 1 : q), a.currency);
}

/** Convert a percentage like 15 or "15.00" to basis points (1500). */
export function pctToBps(pct: number | string): number {
  const n = typeof pct === 'string' ? Number(pct) : pct;
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new MoneyError(`Invalid percentage: ${pct}`);
  return Math.round(n * 100);
}

export function bpsToPctString(bps: number): string {
  return (bps / 100).toFixed(2);
}

/**
 * Split an amount into n parts that sum exactly to the original (largest-remainder),
 * used e.g. for clawback instalments across future payouts.
 */
export function allocate(a: Money, parts: number): Money[] {
  assertInt(parts, 'parts');
  if (parts <= 0) throw new MoneyError('parts must be > 0');
  const base = Math.trunc(a.minor / parts);
  let rem = a.minor - base * parts;
  const step = rem >= 0 ? 1 : -1;
  return Array.from({ length: parts }, () => {
    const extra = rem !== 0 ? step : 0;
    rem -= extra;
    return money(base + extra, a.currency);
  });
}

export function formatMoney(m: Money, locale = 'en-MU'): string {
  const exp = currencyExponent(m.currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency, minimumFractionDigits: exp, maximumFractionDigits: exp })
      .format(m.minor / 10 ** exp);
  } catch {
    return `${m.currency} ${toMajorString(m)}`;
  }
}
