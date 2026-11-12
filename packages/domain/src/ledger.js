"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnbalancedJournalError = exports.LEDGER_ACCOUNTS = void 0;
exports.assertBalanced = assertBalanced;
exports.paymentCapturedJournal = paymentCapturedJournal;
exports.payoutReleasedJournal = payoutReleasedJournal;
exports.computeSettlement = computeSettlement;
exports.refundInitiatedJournal = refundInitiatedJournal;
exports.refundPaidJournal = refundPaidJournal;
exports.clawbackWriteOffJournal = clawbackWriteOffJournal;
exports.chargebackJournal = chargebackJournal;
exports.duplicatePaymentJournal = duplicatePaymentJournal;
exports.goodwillRefundJournal = goodwillRefundJournal;
exports.balances = balances;
const fees_1 = require("./fees");
const money_1 = require("./money");
/**
 * Double-entry ledger postings (spec §F.3).
 *
 * The ledger is append-only. Every money movement is a Journal whose debits equal
 * its credits (per currency). Reversals are new journals, never edits.
 *
 * NOTE ON THE SPEC'S EXAMPLE POSTINGS: §F.3 shows "DEBIT customer_receivable /
 * CREDIT cash_settlement" at capture and then three further credits without a
 * matching debit, which would not balance. The implementation below is the
 * balanced equivalent of the spec's intent ("revenue recognised at capture,
 * provider share held as a liability until payout"):
 *
 *   capture:  DR cash_settlement            charge
 *             CR platform_fee_revenue       fee
 *             CR platform_commission_revenue commission
 *             CR provider_payable           net
 *   payout:   DR provider_payable           net
 *             CR cash_settlement            net (minus any clawback recovered)
 *             CR provider_clawback_receivable  recovered
 *   refund:   DR revenue / provider_payable (or clawback receivable)   ...
 *             CR refund_liability           refund
 *   refund paid: DR refund_liability / CR cash_settlement
 */
exports.LEDGER_ACCOUNTS = [
    'cash_settlement', // asset: money at the platform's settlement bank (MIPS settles here)
    'customer_receivable', // asset: owed by customers (reserved for future pay-later flows)
    'provider_clawback_receivable', // asset: owed back by providers after a post-release refund
    'provider_payable', // liability: owed to providers (the "held" funds)
    'refund_liability', // liability: refunds approved but not yet paid out
    'platform_fee_revenue', // revenue: customer-side platform fee
    'platform_commission_revenue', // revenue: provider-side commission
    'platform_reserve', // equity reserve: absorbs write-offs / chargeback losses
];
const DEBIT_NORMAL = new Set(['cash_settlement', 'customer_receivable', 'provider_clawback_receivable']);
class UnbalancedJournalError extends Error {
}
exports.UnbalancedJournalError = UnbalancedJournalError;
function assertBalanced(j) {
    const byCurrency = new Map();
    for (const l of j.lines) {
        if (l.amount.minor < 0)
            throw new UnbalancedJournalError(`Negative line amount in ${j.kind}`);
        const cur = byCurrency.get(l.amount.currency) ?? 0;
        byCurrency.set(l.amount.currency, cur + (l.side === 'debit' ? l.amount.minor : -l.amount.minor));
    }
    for (const [c, net] of byCurrency) {
        if (net !== 0)
            throw new UnbalancedJournalError(`Journal ${j.kind} unbalanced in ${c} by ${net}`);
    }
}
function journal(kind, memo, lines) {
    const j = { kind, memo, lines: lines.filter(l => l.amount.minor !== 0) };
    assertBalanced(j);
    return j;
}
const dr = (account, amount) => ({ account, side: 'debit', amount });
const cr = (account, amount) => ({ account, side: 'credit', amount });
/** Posted when a verified MIPS success callback is processed. */
function paymentCapturedJournal(b) {
    return journal('payment_captured', 'Customer payment captured; provider share held', [
        dr('cash_settlement', b.customerCharge),
        cr('platform_fee_revenue', b.customerFee),
        cr('platform_commission_revenue', b.providerCommission),
        cr('provider_payable', b.providerNet),
    ]);
}
/**
 * Posted when the disbursement rail confirms a payout. `clawbackRecovered` is the
 * portion of this payout withheld to settle an outstanding provider clawback.
 */
function payoutReleasedJournal(net, clawbackRecovered = (0, money_1.money)(0, net.currency)) {
    if (clawbackRecovered.minor > net.minor)
        throw new Error('Cannot recover more than the payout');
    return journal('payout_released', 'Provider payout disbursed', [
        dr('provider_payable', net),
        cr('cash_settlement', (0, money_1.sub)(net, clawbackRecovered)),
        cr('provider_clawback_receivable', clawbackRecovered),
    ]);
}
function computeSettlement(original, adjustedAgreed) {
    const c = original.agreed.currency;
    if (adjustedAgreed.currency !== c)
        throw new Error('Currency mismatch');
    if (adjustedAgreed.minor < 0 || adjustedAgreed.minor > original.agreed.minor) {
        throw new Error('Adjusted amount must be between 0 and the original agreed amount');
    }
    const adjusted = adjustedAgreed.minor === 0
        ? null
        : (0, fees_1.computeFees)(adjustedAgreed, { customerFeeBps: original.customerFeeBps, providerCommissionBps: original.providerCommissionBps });
    const z = (0, money_1.money)(0, c);
    const s = {
        original,
        adjusted,
        refundToCustomer: (0, money_1.sub)(original.customerCharge, adjusted?.customerCharge ?? z),
        providerReduction: (0, money_1.sub)(original.providerNet, adjusted?.providerNet ?? z),
        feeReduction: (0, money_1.sub)(original.customerFee, adjusted?.customerFee ?? z),
        commissionReduction: (0, money_1.sub)(original.providerCommission, adjusted?.providerCommission ?? z),
        providerNetAfter: adjusted?.providerNet ?? z,
    };
    if (s.refundToCustomer.minor !== s.providerReduction.minor + s.feeReduction.minor + s.commissionReduction.minor) {
        throw new Error('Settlement does not conserve money');
    }
    return s;
}
/**
 * Posted when a refund is approved. If the provider's payout was already
 * released, the provider's share is recorded as a clawback receivable
 * (recovered from future payouts, §F.5) instead of reducing provider_payable.
 */
function refundInitiatedJournal(s, payoutAlreadyReleased) {
    return journal('refund_initiated', payoutAlreadyReleased ? 'Refund approved after payout; provider clawback opened' : 'Refund approved', [
        dr('platform_fee_revenue', s.feeReduction),
        dr('platform_commission_revenue', s.commissionReduction),
        dr(payoutAlreadyReleased ? 'provider_clawback_receivable' : 'provider_payable', s.providerReduction),
        cr('refund_liability', s.refundToCustomer),
    ]);
}
/** Posted when MIPS (or the alternate rail) confirms the refund left the platform account. */
function refundPaidJournal(amount) {
    return journal('refund_paid', 'Refund paid to customer', [
        dr('refund_liability', amount),
        cr('cash_settlement', amount),
    ]);
}
/** Unrecoverable clawback absorbed by the platform reserve. */
function clawbackWriteOffJournal(amount) {
    return journal('clawback_written_off', 'Uncollectable provider clawback written off to reserve', [
        dr('platform_reserve', amount),
        cr('provider_clawback_receivable', amount),
    ]);
}
/** Chargeback debited by the acquirer: cash leaves immediately; loss sits in reserve until evidence outcome. */
function chargebackJournal(amount) {
    return journal('chargeback_received', 'Card chargeback debited by acquirer', [
        dr('platform_reserve', amount),
        cr('cash_settlement', amount),
    ]);
}
/** A second successful charge for an already-paid booking: hold as refund liability, refund in full. */
function duplicatePaymentJournal(amount) {
    return journal('duplicate_payment', 'Duplicate customer payment received; to be refunded', [
        dr('cash_settlement', amount),
        cr('refund_liability', amount),
    ]);
}
/** Platform-funded goodwill refund (support/admin): provider's payout is untouched. */
function goodwillRefundJournal(amount) {
    return journal('goodwill_refund', 'Goodwill refund funded by platform reserve', [
        dr('platform_reserve', amount),
        cr('refund_liability', amount),
    ]);
}
/** Natural-sign balance per account (positive = normal balance) from a list of lines. */
function balances(lines, currency) {
    const out = Object.fromEntries(exports.LEDGER_ACCOUNTS.map(a => [a, 0]));
    for (const l of lines) {
        if (l.amount.currency !== currency)
            continue;
        const signed = l.side === 'debit' ? l.amount.minor : -l.amount.minor;
        out[l.account] += DEBIT_NORMAL.has(l.account) ? signed : -signed;
    }
    return out;
}
