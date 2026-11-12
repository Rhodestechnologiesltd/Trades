/** Mauritius numbers are 8 digits (mobiles start with 5); E.164 = +230XXXXXXXX. Other countries type the full +code. */
export function toE164(raw: string, defaultCountryCode = '230'): string {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 8) return `+${defaultCountryCode}${d}`;
  return `+${d}`;
}

export const isE164 = (s: string) => /^\+[1-9]\d{6,14}$/.test(s);

/** Accepts "1,250.50", "1250", "1250.5" → "1250.50" or null when invalid. */
export function normalizeAmount(input: string): string | null {
  const s = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n.toFixed(2) : null;
}
