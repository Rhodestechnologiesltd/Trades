"use strict";
/**
 * Money is always handled as integer minor units (e.g. cents) inside the domain
 * so that fee/commission arithmetic is exact. The database stores NUMERIC(12,2)
 * per spec §D; conversion happens only at the persistence/API boundary.
 *
 * Currency is never hard-coded (spec §0 / §B.3): every Money carries its code.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoneyError = void 0;
exports.currencyExponent = currencyExponent;
exports.money = money;
exports.fromMajor = fromMajor;
exports.toMajorString = toMajorString;
exports.add = add;
exports.sub = sub;
exports.isZero = isZero;
exports.isPositive = isPositive;
exports.eq = eq;
exports.gt = gt;
exports.zero = zero;
exports.percentOf = percentOf;
exports.pctToBps = pctToBps;
exports.bpsToPctString = bpsToPctString;
exports.allocate = allocate;
exports.formatMoney = formatMoney;
/** Minor-unit exponent per currency. Unknown currencies default to 2. */
const EXPONENTS = {
    MUR: 2, USD: 2, EUR: 2, GBP: 2, ZAR: 2, INR: 2, KES: 2,
    JPY: 0, KRW: 0, XOF: 0, XAF: 0,
    BHD: 3, KWD: 3, OMR: 3, TND: 3,
};
function currencyExponent(currency) {
    return EXPONENTS[currency.toUpperCase()] ?? 2;
}
class MoneyError extends Error {
}
exports.MoneyError = MoneyError;
function assertInt(n, label) {
    if (!Number.isSafeInteger(n))
        throw new MoneyError(`${label} must be a safe integer, got ${n}`);
}
function money(minor, currency) {
    assertInt(minor, 'minor');
    if (!/^[A-Z]{3}$/.test(currency))
        throw new MoneyError(`Invalid currency code: ${currency}`);
    return Object.freeze({ minor, currency });
}
/** Parse a decimal string/number in major units ("1250.50") to Money without float drift. */
function fromMajor(amount, currency) {
    const exp = currencyExponent(currency);
    const s = typeof amount === 'number' ? amount.toFixed(exp) : amount.trim();
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m)
        throw new MoneyError(`Invalid amount: ${amount}`);
    const [, neg, whole, fracRaw = ''] = m;
    if (fracRaw.length > exp && /[1-9]/.test(fracRaw.slice(exp))) {
        throw new MoneyError(`Amount ${amount} has more precision than ${currency} allows`);
    }
    const frac = (fracRaw + '0'.repeat(exp)).slice(0, exp);
    const minor = Number(whole) * 10 ** exp + (exp ? Number(frac) : 0);
    return money(neg ? -minor : minor, currency);
}
/** Format to a decimal string in major units, suitable for NUMERIC columns and gateway APIs. */
function toMajorString(m) {
    const exp = currencyExponent(m.currency);
    const neg = m.minor < 0;
    const abs = Math.abs(m.minor);
    if (exp === 0)
        return `${neg ? '-' : ''}${abs}`;
    const s = abs.toString().padStart(exp + 1, '0');
    return `${neg ? '-' : ''}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}
function sameCurrency(a, b) {
    if (a.currency !== b.currency)
        throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}
function add(a, b) { sameCurrency(a, b); return money(a.minor + b.minor, a.currency); }
function sub(a, b) { sameCurrency(a, b); return money(a.minor - b.minor, a.currency); }
function isZero(a) { return a.minor === 0; }
function isPositive(a) { return a.minor > 0; }
function eq(a, b) { return a.currency === b.currency && a.minor === b.minor; }
function gt(a, b) { sameCurrency(a, b); return a.minor > b.minor; }
function zero(currency) { return money(0, currency); }
/**
 * Multiply by a percentage expressed in basis points (1500 bps = 15.00%).
 * Uses round-half-up on the absolute value (commercial rounding), which is
 * what finance teams expect on invoices. Basis points avoid float percentages.
 */
function percentOf(a, basisPoints) {
    assertInt(basisPoints, 'basisPoints');
    const sign = a.minor < 0 ? -1 : 1;
    const product = Math.abs(a.minor) * basisPoints; // safe: 1e12 minor * 1e4 bps < 2^53 only up to ~9e11; guard below
    if (!Number.isSafeInteger(product))
        throw new MoneyError('Amount too large for percentage computation');
    const q = Math.floor(product / 10_000);
    const r = product % 10_000;
    return money(sign * (r * 2 >= 10_000 ? q + 1 : q), a.currency);
}
/** Convert a percentage like 15 or "15.00" to basis points (1500). */
function pctToBps(pct) {
    const n = typeof pct === 'string' ? Number(pct) : pct;
    if (!Number.isFinite(n) || n < 0 || n > 100)
        throw new MoneyError(`Invalid percentage: ${pct}`);
    return Math.round(n * 100);
}
function bpsToPctString(bps) {
    return (bps / 100).toFixed(2);
}
/**
 * Split an amount into n parts that sum exactly to the original (largest-remainder),
 * used e.g. for clawback instalments across future payouts.
 */
function allocate(a, parts) {
    assertInt(parts, 'parts');
    if (parts <= 0)
        throw new MoneyError('parts must be > 0');
    const base = Math.trunc(a.minor / parts);
    let rem = a.minor - base * parts;
    const step = rem >= 0 ? 1 : -1;
    return Array.from({ length: parts }, () => {
        const extra = rem !== 0 ? step : 0;
        rem -= extra;
        return money(base + extra, a.currency);
    });
}
function formatMoney(m, locale = 'en-MU') {
    const exp = currencyExponent(m.currency);
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency, minimumFractionDigits: exp, maximumFractionDigits: exp })
            .format(m.minor / 10 ** exp);
    }
    catch {
        return `${m.currency} ${toMajorString(m)}`;
    }
}
