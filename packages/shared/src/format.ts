import type { BookingStatus, DisputeReason, RequestStatus } from './types';

export function formatMoney(amount: string | number | null | undefined, currency = 'MUR', locale = 'en-MU'): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = typeof amount === 'number' ? amount : Number(amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** Customer-facing fee preview (matches backend computeFees for the default config; the server is authoritative). */
export function previewCustomerTotal(agreed: string, feePct = 15): { fee: string; total: string } {
  const minor = Math.round(Number(agreed) * 100);
  const fee = Math.floor((minor * feePct * 100 + 5000) / 10000);
  return { fee: (fee / 100).toFixed(2), total: ((minor + fee) / 100).toFixed(2) };
}

export function previewProviderNet(agreed: string, commissionPct = 15): { commission: string; net: string } {
  const minor = Math.round(Number(agreed) * 100);
  const c = Math.floor((minor * commissionPct * 100 + 5000) / 10000);
  return { commission: (c / 100).toFixed(2), net: ((minor - c) / 100).toFixed(2) };
}

export function formatDateTime(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(iso)); } catch { return iso; }
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function timeUntil(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d`;
}

export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export const BOOKING_STATUS: Record<BookingStatus, { customer: string; provider: string; tone: Tone }> = {
  payment_pending:       { customer: 'Awaiting your payment', provider: 'Waiting for customer payment', tone: 'warning' },
  payment_authorized:    { customer: 'Paid — confirming', provider: 'Paid', tone: 'info' },
  assigned:              { customer: 'Confirmed', provider: 'Ready to start', tone: 'info' },
  in_progress:           { customer: 'In progress', provider: 'In progress', tone: 'info' },
  completed_by_provider: { customer: 'Please review & approve', provider: 'Awaiting customer approval', tone: 'warning' },
  approved_by_customer:  { customer: 'Approved', provider: 'Approved', tone: 'success' },
  payout_pending:        { customer: 'Completed', provider: 'Payout scheduled', tone: 'success' },
  payout_released:       { customer: 'Completed', provider: 'Paid out', tone: 'success' },
  cancelled:             { customer: 'Cancelled', provider: 'Cancelled', tone: 'neutral' },
  disputed:              { customer: 'Under review', provider: 'Disputed', tone: 'danger' },
  refund_pending:        { customer: 'Refund in progress', provider: 'Refund in progress', tone: 'neutral' },
  refunded:              { customer: 'Refunded', provider: 'Refunded', tone: 'neutral' },
};

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  requested: { label: 'Submitted', tone: 'info' },
  matching: { label: 'Finding pros', tone: 'info' },
  dispatched: { label: 'Waiting for quotes', tone: 'info' },
  quoted: { label: 'Quotes received', tone: 'success' },
  accepted: { label: 'Booked', tone: 'success' },
  expired: { label: 'No pros available', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const DISPUTE_REASONS: Record<DisputeReason, string> = {
  no_show: 'Provider did not show up',
  incomplete_work: 'Work not finished',
  damage: 'Something was damaged',
  overcharge: 'I was overcharged',
  unsafe_conduct: 'Unsafe or inappropriate behaviour',
  other: 'Something else',
};

/** Ionicons names for category slugs (admin may set its own icon). */
export const CATEGORY_ICONS: Record<string, string> = {
  electrical: 'flash', plumbing: 'water', childcare: 'happy', cleaning: 'sparkles', mechanics: 'car', 'tyre-repair': 'disc',
  handyman: 'hammer', 'ac-repair': 'snow', painting: 'color-palette', gardening: 'leaf', 'appliance-repair': 'construct', 'delivery-helpers': 'cube',
};

/** Build an RRULE from a simple weekly picker. */
export function weeklyRule(days: Array<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'>, hour: number, minute = 0, intervalWeeks = 1): string {
  return `FREQ=WEEKLY;INTERVAL=${intervalWeeks};BYDAY=${days.join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
}
