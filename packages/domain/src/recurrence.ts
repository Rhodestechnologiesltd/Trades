/**
 * Minimal RRULE support for recurring agreements (spec §A.3, §D.3 cadence_rule).
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY; INTERVAL; BYDAY (weekly); BYMONTHDAY (monthly);
 * BYHOUR; BYMINUTE; COUNT; UNTIL. Times are evaluated as wall-clock time in the
 * market's IANA timezone, so "every Tuesday 09:00" stays 09:00 across DST changes.
 *
 * Example: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=15;BYMINUTE=0"
 */

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type Day = typeof DAYS[number];

export interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay?: Day[];
  byMonthDay?: number[];
  hour: number;
  minute: number;
  count?: number;
  until?: Date;
}

export class RecurrenceError extends Error {}

export function parseRule(rule: string): ParsedRule {
  const parts = Object.fromEntries(
    rule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map(kv => {
      const [k, v] = kv.split('=');
      return [k.trim().toUpperCase(), (v ?? '').trim().toUpperCase()];
    }),
  );
  const freq = parts.FREQ as ParsedRule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) throw new RecurrenceError(`Unsupported FREQ: ${parts.FREQ}`);
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new RecurrenceError('INTERVAL must be 1..52');
  const byDay = parts.BYDAY ? parts.BYDAY.split(',').map(d => {
    if (!DAYS.includes(d as Day)) throw new RecurrenceError(`Bad BYDAY ${d}`);
    return d as Day;
  }) : undefined;
  const byMonthDay = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number) : undefined;
  if (byMonthDay?.some(d => !Number.isInteger(d) || d < 1 || d > 28)) throw new RecurrenceError('BYMONTHDAY must be 1..28');
  const hour = parts.BYHOUR ? Number(parts.BYHOUR) : 9;
  const minute = parts.BYMINUTE ? Number(parts.BYMINUTE) : 0;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) throw new RecurrenceError('Bad BYHOUR/BYMINUTE');
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  let until: Date | undefined;
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts.UNTIL);
    if (!m) throw new RecurrenceError('Bad UNTIL');
    until = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)));
  }
  return { freq, interval, byDay, byMonthDay, hour, minute, count, until };
}

/** Offset (ms) of `tz` from UTC at instant `d`. */
function tzOffsetMs(d: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `tz` to a UTC instant. */
export function zonedWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(guess - off1), tz);
  return new Date(guess - off2);
}

function wallDate(d: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month - 1, d: +p.day, dow };
}

/**
 * Occurrences strictly after `after`, starting from the agreement's `start`,
 * up to `limit` items or `horizon`.
 */
export function occurrences(rule: string, start: Date, tz: string, opts: { after?: Date; horizon?: Date; limit?: number } = {}): Date[] {
  const r = parseRule(rule);
  const limit = opts.limit ?? 50;
  const after = opts.after ?? new Date(start.getTime() - 1);
  const horizon = opts.horizon ?? new Date(start.getTime() + 366 * 24 * 3600 * 1000);
  const out: Date[] = [];
  const s = wallDate(start, tz);
  let produced = 0;
  // Iterate calendar days in wall time from start; bounded loop for safety.
  for (let i = 0; i < 3 * 366 && out.length < limit; i++) {
    const day = new Date(Date.UTC(s.y, s.m, s.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate(), dow = day.getUTCDay();
    let match = false;
    if (r.freq === 'DAILY') match = i % r.interval === 0;
    else if (r.freq === 'WEEKLY') {
      const days = r.byDay ?? [DAYS[s.dow]];
      const weekIndex = Math.floor((i + s.dow) / 7);
      match = days.includes(DAYS[dow]) && weekIndex % r.interval === 0;
    } else {
      const monthsSince = (y - s.y) * 12 + (m - s.m);
      match = (r.byMonthDay ?? [s.d]).includes(d) && monthsSince % r.interval === 0;
    }
    if (!match) continue;
    const at = zonedWallTimeToUtc(y, m, d, r.hour, r.minute, tz);
    if (at < start) continue;
    if (r.until && at > r.until) break;
    if (at > horizon) break;
    produced++;
    if (r.count && produced > r.count) break;
    if (at > after) out.push(at);
  }
  return out;
}

export function describeRule(rule: string): string {
  const r = parseRule(rule);
  const time = `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
  const names: Record<Day, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
  const every = r.interval === 1 ? 'Every' : `Every ${r.interval}`;
  if (r.freq === 'DAILY') return `${every} day${r.interval > 1 ? 's' : ''} at ${time}`;
  if (r.freq === 'WEEKLY') return `${every} week${r.interval > 1 ? 's' : ''} on ${(r.byDay ?? []).map(d => names[d]).join(', ') || 'the same day'} at ${time}`;
  return `${every} month${r.interval > 1 ? 's' : ''} on day ${(r.byMonthDay ?? []).join(', ') || 'same'} at ${time}`;
}
