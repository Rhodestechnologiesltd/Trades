"use strict";
/**
 * Minimal RRULE support for recurring agreements (spec §A.3, §D.3 cadence_rule).
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY; INTERVAL; BYDAY (weekly); BYMONTHDAY (monthly);
 * BYHOUR; BYMINUTE; COUNT; UNTIL. Times are evaluated as wall-clock time in the
 * market's IANA timezone, so "every Tuesday 09:00" stays 09:00 across DST changes.
 *
 * Example: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=15;BYMINUTE=0"
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecurrenceError = void 0;
exports.parseRule = parseRule;
exports.zonedWallTimeToUtc = zonedWallTimeToUtc;
exports.occurrences = occurrences;
exports.describeRule = describeRule;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
class RecurrenceError extends Error {
}
exports.RecurrenceError = RecurrenceError;
function parseRule(rule) {
    const parts = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map(kv => {
        const [k, v] = kv.split('=');
        return [k.trim().toUpperCase(), (v ?? '').trim().toUpperCase()];
    }));
    const freq = parts.FREQ;
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq))
        throw new RecurrenceError(`Unsupported FREQ: ${parts.FREQ}`);
    const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
    if (!Number.isInteger(interval) || interval < 1 || interval > 52)
        throw new RecurrenceError('INTERVAL must be 1..52');
    const byDay = parts.BYDAY ? parts.BYDAY.split(',').map(d => {
        if (!DAYS.includes(d))
            throw new RecurrenceError(`Bad BYDAY ${d}`);
        return d;
    }) : undefined;
    const byMonthDay = parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number) : undefined;
    if (byMonthDay?.some(d => !Number.isInteger(d) || d < 1 || d > 28))
        throw new RecurrenceError('BYMONTHDAY must be 1..28');
    const hour = parts.BYHOUR ? Number(parts.BYHOUR) : 9;
    const minute = parts.BYMINUTE ? Number(parts.BYMINUTE) : 0;
    if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59))
        throw new RecurrenceError('Bad BYHOUR/BYMINUTE');
    const count = parts.COUNT ? Number(parts.COUNT) : undefined;
    let until;
    if (parts.UNTIL) {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts.UNTIL);
        if (!m)
            throw new RecurrenceError('Bad UNTIL');
        until = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)));
    }
    return { freq, interval, byDay, byMonthDay, hour, minute, count, until };
}
/** Offset (ms) of `tz` from UTC at instant `d`. */
function tzOffsetMs(d, tz) {
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}
/** Convert a wall-clock time in `tz` to a UTC instant. */
function zonedWallTimeToUtc(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo, d, h, mi);
    const off1 = tzOffsetMs(new Date(guess), tz);
    const off2 = tzOffsetMs(new Date(guess - off1), tz);
    return new Date(guess - off2);
}
function wallDate(d, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
    const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return { y: +p.year, m: +p.month - 1, d: +p.day, dow };
}
/**
 * Occurrences strictly after `after`, starting from the agreement's `start`,
 * up to `limit` items or `horizon`.
 */
function occurrences(rule, start, tz, opts = {}) {
    const r = parseRule(rule);
    const limit = opts.limit ?? 50;
    const after = opts.after ?? new Date(start.getTime() - 1);
    const horizon = opts.horizon ?? new Date(start.getTime() + 366 * 24 * 3600 * 1000);
    const out = [];
    const s = wallDate(start, tz);
    let produced = 0;
    // Iterate calendar days in wall time from start; bounded loop for safety.
    for (let i = 0; i < 3 * 366 && out.length < limit; i++) {
        const day = new Date(Date.UTC(s.y, s.m, s.d + i));
        const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate(), dow = day.getUTCDay();
        let match = false;
        if (r.freq === 'DAILY')
            match = i % r.interval === 0;
        else if (r.freq === 'WEEKLY') {
            const days = r.byDay ?? [DAYS[s.dow]];
            const weekIndex = Math.floor((i + s.dow) / 7);
            match = days.includes(DAYS[dow]) && weekIndex % r.interval === 0;
        }
        else {
            const monthsSince = (y - s.y) * 12 + (m - s.m);
            match = (r.byMonthDay ?? [s.d]).includes(d) && monthsSince % r.interval === 0;
        }
        if (!match)
            continue;
        const at = zonedWallTimeToUtc(y, m, d, r.hour, r.minute, tz);
        if (at < start)
            continue;
        if (r.until && at > r.until)
            break;
        if (at > horizon)
            break;
        produced++;
        if (r.count && produced > r.count)
            break;
        if (at > after)
            out.push(at);
    }
    return out;
}
function describeRule(rule) {
    const r = parseRule(rule);
    const time = `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
    const names = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
    const every = r.interval === 1 ? 'Every' : `Every ${r.interval}`;
    if (r.freq === 'DAILY')
        return `${every} day${r.interval > 1 ? 's' : ''} at ${time}`;
    if (r.freq === 'WEEKLY')
        return `${every} week${r.interval > 1 ? 's' : ''} on ${(r.byDay ?? []).map(d => names[d]).join(', ') || 'the same day'} at ${time}`;
    return `${every} month${r.interval > 1 ? 's' : ''} on day ${(r.byMonthDay ?? []).join(', ') || 'same'} at ${time}`;
}
