/**
 * Time-based business policies (spec §A.9, §A.10, §C.5, §C.8, §F).
 * All windows are configuration with spec defaults; every scheduler job uses
 * these pure functions so behaviour is identical in tests and production.
 */
import { Money, money, percentOf } from './money';

export interface TimingPolicy {
  /** Customer must pay within this long after accepting a quote. */
  paymentWindowSec: number;
  /** Auto-approve completion if the customer doesn't respond (§C.5: 48–72h). */
  autoApproveAfterSec: number;
  /** Reminder before auto-approve fires. */
  autoApproveReminderBeforeSec: number;
  /** Payout eligible this long after approval (spec: T+48h). */
  payoutDelaySec: number;
  /** Dispute window after completion (spec default 72h). */
  disputeWindowSec: number;
  /** Double-blind review release window. */
  reviewWindowSec: number;
  /** Assigned provider must start within this long after the scheduled start (no-show). */
  noShowGraceSec: number;
}

export const DEFAULT_TIMING: TimingPolicy = {
  paymentWindowSec: 30 * 60,
  autoApproveAfterSec: 48 * 3600,
  autoApproveReminderBeforeSec: 6 * 3600,
  payoutDelaySec: 48 * 3600,
  disputeWindowSec: 72 * 3600,
  reviewWindowSec: 14 * 24 * 3600,
  noShowGraceSec: 45 * 60,
};

const addSec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

export const autoApproveAt = (completedAt: Date, p = DEFAULT_TIMING) => addSec(completedAt, p.autoApproveAfterSec);
export const payoutEligibleAt = (approvedAt: Date, p = DEFAULT_TIMING) => addSec(approvedAt, p.payoutDelaySec);
export const disputeDeadline = (completedAt: Date, p = DEFAULT_TIMING) => addSec(completedAt, p.disputeWindowSec);

/**
 * May a dispute be opened now? (§A.10) — within the window after completion,
 * or at any time before completion (no-show, job never started, unsafe conduct).
 */
export function canOpenDispute(state: string, completedAt: Date | null, now: Date, p = DEFAULT_TIMING): boolean {
  if (['in_progress', 'assigned'].includes(state)) return true;
  if (!completedAt) return false;
  if (!['completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released'].includes(state)) return false;
  return now.getTime() <= disputeDeadline(completedAt, p).getTime();
}

/**
 * Double-blind review release (§A.9): a review becomes visible when BOTH parties
 * have reviewed, or when the review window closes — whichever is first.
 */
export function reviewVisibleAt(params: { submittedAt: Date; counterpartReviewedAt: Date | null; jobCompletedAt: Date }, p = DEFAULT_TIMING): Date {
  const windowClose = addSec(params.jobCompletedAt, p.reviewWindowSec);
  if (params.counterpartReviewedAt) {
    const both = new Date(Math.max(params.submittedAt.getTime(), params.counterpartReviewedAt.getTime()));
    return both < windowClose ? both : windowClose;
  }
  return windowClose;
}

/* ─────────────────────────── Cancellation policy ─────────────────────────── */

export interface CancellationPolicy {
  /** Free cancellation if more than this before scheduled start. */
  freeCancelBeforeSec: number;
  /** Late customer cancellation keeps this % of agreed (bps) for the provider. */
  lateCancelFeeBps: number;
  /** Minimum late cancellation fee in minor units. */
  lateCancelMinMinor: number;
}

export const DEFAULT_CANCELLATION: CancellationPolicy = {
  freeCancelBeforeSec: 2 * 3600,
  lateCancelFeeBps: 1000,
  lateCancelMinMinor: 20000, // MUR 200.00
};

export type CancelActor = 'customer' | 'provider' | 'admin' | 'support' | 'system';

export interface CancellationOutcome {
  /** Adjusted agreed amount after cancellation (0 = full refund). Feed into computeSettlement. */
  adjustedAgreed: Money;
  providerPenalty: boolean;
  reason: string;
}

/**
 * Who pays when a booking is cancelled after payment (§C.5 "refund policy depends on state").
 *  - before assignment, or provider cancels / no-shows → full refund; provider penalised if at fault
 *  - customer cancels after assignment within the late window → late-cancel fee retained
 *  - admin/support cancellations → full refund (staff can adjust via dispute tools if needed)
 */
export function cancellationOutcome(params: {
  bookingState: string;
  actor: CancelActor;
  agreed: Money;
  scheduledStart: Date | null;
  now: Date;
  isNoShow?: boolean;
}, p = DEFAULT_CANCELLATION): CancellationOutcome {
  const z = money(0, params.agreed.currency);
  if (params.isNoShow) return { adjustedAgreed: z, providerPenalty: true, reason: 'Provider no-show: full refund' };
  if (params.bookingState === 'payment_pending') return { adjustedAgreed: z, providerPenalty: false, reason: 'Unpaid booking cancelled' };
  if (params.actor === 'provider') return { adjustedAgreed: z, providerPenalty: true, reason: 'Provider cancelled: full refund' };
  if (params.actor !== 'customer') return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled by platform: full refund' };
  if (params.bookingState === 'payment_authorized') return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled before assignment: full refund' };
  const start = params.scheduledStart ?? params.now; // urgent jobs: start is "now"
  const secondsToStart = (start.getTime() - params.now.getTime()) / 1000;
  if (secondsToStart > p.freeCancelBeforeSec) return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled outside late window: full refund' };
  const fee = percentOf(params.agreed, p.lateCancelFeeBps);
  const feeMinor = Math.min(params.agreed.minor, Math.max(fee.minor, p.lateCancelMinMinor));
  return { adjustedAgreed: money(feeMinor, params.agreed.currency), providerPenalty: false, reason: 'Late cancellation: cancellation fee retained' };
}

/* ───────────────────────────── Abuse limits ───────────────────────────── */

export interface AbuseLimits {
  maxQuotesPerProviderPerHour: number;
  maxUrgentRequestsPerCustomerPerDay: number;
  maxPaymentAttemptsPerCustomerPerHour: number;
  maxOtpRequestsPerPhonePerHour: number;
  clawbackMaxShareOfPayoutBps: number;
  noShowSuspensionThreshold: number;
}

export const DEFAULT_ABUSE_LIMITS: AbuseLimits = {
  maxQuotesPerProviderPerHour: 30,
  maxUrgentRequestsPerCustomerPerDay: 3,
  maxPaymentAttemptsPerCustomerPerHour: 5,
  maxOtpRequestsPerPhonePerHour: 5,
  clawbackMaxShareOfPayoutBps: 5000, // never withhold more than 50% of a single payout
  noShowSuspensionThreshold: 3,
};

/** Clawback recovery from a payout, capped per §F.5 ("capped per period"). */
export function clawbackRecoveryFor(payoutNet: Money, outstandingMinor: number, limits = DEFAULT_ABUSE_LIMITS): Money {
  const cap = percentOf(payoutNet, limits.clawbackMaxShareOfPayoutBps).minor;
  return money(Math.max(0, Math.min(cap, outstandingMinor)), payoutNet.currency);
}
