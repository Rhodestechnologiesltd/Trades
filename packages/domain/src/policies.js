"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ABUSE_LIMITS = exports.DEFAULT_CANCELLATION = exports.disputeDeadline = exports.payoutEligibleAt = exports.autoApproveAt = exports.DEFAULT_TIMING = void 0;
exports.canOpenDispute = canOpenDispute;
exports.reviewVisibleAt = reviewVisibleAt;
exports.cancellationOutcome = cancellationOutcome;
exports.clawbackRecoveryFor = clawbackRecoveryFor;
/**
 * Time-based business policies (spec §A.9, §A.10, §C.5, §C.8, §F).
 * All windows are configuration with spec defaults; every scheduler job uses
 * these pure functions so behaviour is identical in tests and production.
 */
const money_1 = require("./money");
exports.DEFAULT_TIMING = {
    paymentWindowSec: 30 * 60,
    autoApproveAfterSec: 48 * 3600,
    autoApproveReminderBeforeSec: 6 * 3600,
    payoutDelaySec: 48 * 3600,
    disputeWindowSec: 72 * 3600,
    reviewWindowSec: 14 * 24 * 3600,
    noShowGraceSec: 45 * 60,
};
const addSec = (d, s) => new Date(d.getTime() + s * 1000);
const autoApproveAt = (completedAt, p = exports.DEFAULT_TIMING) => addSec(completedAt, p.autoApproveAfterSec);
exports.autoApproveAt = autoApproveAt;
const payoutEligibleAt = (approvedAt, p = exports.DEFAULT_TIMING) => addSec(approvedAt, p.payoutDelaySec);
exports.payoutEligibleAt = payoutEligibleAt;
const disputeDeadline = (completedAt, p = exports.DEFAULT_TIMING) => addSec(completedAt, p.disputeWindowSec);
exports.disputeDeadline = disputeDeadline;
/**
 * May a dispute be opened now? (§A.10) — within the window after completion,
 * or at any time before completion (no-show, job never started, unsafe conduct).
 */
function canOpenDispute(state, completedAt, now, p = exports.DEFAULT_TIMING) {
    if (['in_progress', 'assigned'].includes(state))
        return true;
    if (!completedAt)
        return false;
    if (!['completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released'].includes(state))
        return false;
    return now.getTime() <= (0, exports.disputeDeadline)(completedAt, p).getTime();
}
/**
 * Double-blind review release (§A.9): a review becomes visible when BOTH parties
 * have reviewed, or when the review window closes — whichever is first.
 */
function reviewVisibleAt(params, p = exports.DEFAULT_TIMING) {
    const windowClose = addSec(params.jobCompletedAt, p.reviewWindowSec);
    if (params.counterpartReviewedAt) {
        const both = new Date(Math.max(params.submittedAt.getTime(), params.counterpartReviewedAt.getTime()));
        return both < windowClose ? both : windowClose;
    }
    return windowClose;
}
exports.DEFAULT_CANCELLATION = {
    freeCancelBeforeSec: 2 * 3600,
    lateCancelFeeBps: 1000,
    lateCancelMinMinor: 20000, // MUR 200.00
};
/**
 * Who pays when a booking is cancelled after payment (§C.5 "refund policy depends on state").
 *  - before assignment, or provider cancels / no-shows → full refund; provider penalised if at fault
 *  - customer cancels after assignment within the late window → late-cancel fee retained
 *  - admin/support cancellations → full refund (staff can adjust via dispute tools if needed)
 */
function cancellationOutcome(params, p = exports.DEFAULT_CANCELLATION) {
    const z = (0, money_1.money)(0, params.agreed.currency);
    if (params.isNoShow)
        return { adjustedAgreed: z, providerPenalty: true, reason: 'Provider no-show: full refund' };
    if (params.bookingState === 'payment_pending')
        return { adjustedAgreed: z, providerPenalty: false, reason: 'Unpaid booking cancelled' };
    if (params.actor === 'provider')
        return { adjustedAgreed: z, providerPenalty: true, reason: 'Provider cancelled: full refund' };
    if (params.actor !== 'customer')
        return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled by platform: full refund' };
    if (params.bookingState === 'payment_authorized')
        return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled before assignment: full refund' };
    const start = params.scheduledStart ?? params.now; // urgent jobs: start is "now"
    const secondsToStart = (start.getTime() - params.now.getTime()) / 1000;
    if (secondsToStart > p.freeCancelBeforeSec)
        return { adjustedAgreed: z, providerPenalty: false, reason: 'Cancelled outside late window: full refund' };
    const fee = (0, money_1.percentOf)(params.agreed, p.lateCancelFeeBps);
    const feeMinor = Math.min(params.agreed.minor, Math.max(fee.minor, p.lateCancelMinMinor));
    return { adjustedAgreed: (0, money_1.money)(feeMinor, params.agreed.currency), providerPenalty: false, reason: 'Late cancellation: cancellation fee retained' };
}
exports.DEFAULT_ABUSE_LIMITS = {
    maxQuotesPerProviderPerHour: 30,
    maxUrgentRequestsPerCustomerPerDay: 3,
    maxPaymentAttemptsPerCustomerPerHour: 5,
    maxOtpRequestsPerPhonePerHour: 5,
    clawbackMaxShareOfPayoutBps: 5000, // never withhold more than 50% of a single payout
    noShowSuspensionThreshold: 3,
};
/** Clawback recovery from a payout, capped per §F.5 ("capped per period"). */
function clawbackRecoveryFor(payoutNet, outstandingMinor, limits = exports.DEFAULT_ABUSE_LIMITS) {
    const cap = (0, money_1.percentOf)(payoutNet, limits.clawbackMaxShareOfPayoutBps).minor;
    return (0, money_1.money)(Math.max(0, Math.min(cap, outstandingMinor)), payoutNet.currency);
}
