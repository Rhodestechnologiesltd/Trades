import { FeeBreakdown, computeFees } from './fees';
import { Money, money, sub } from './money';

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

export const LEDGER_ACCOUNTS = [
  'cash_settlement',               // asset: money at the platform's settlement bank (MIPS settles here)
  'customer_receivable',           // asset: owed by customers (reserved for future pay-later flows)
  'provider_clawback_receivable',  // asset: owed back by providers after a post-release refund
  'provider_payable',              // liability: owed to providers (the "held" funds)
  'refund_liability',              // liability: refunds approved but not yet paid out
  'platform_fee_revenue',          // revenue: customer-side platform fee
  'platform_commission_revenue',   // revenue: provider-side commission
  'platform_reserve',              // equity reserve: absorbs write-offs / chargeback losses
] as const;
export type LedgerAccount = typeof LEDGER_ACCOUNTS[number];

const DEBIT_NORMAL: ReadonlySet<LedgerAccount> = new Set(['cash_settlement', 'customer_receivable', 'provider_clawback_receivable']);

export type EntrySide = 'debit' | 'credit';

export interface LedgerLine {
  account: LedgerAccount;
  side: EntrySide;
  amount: Money;
}

export type JournalKind =
  | 'payment_captured' | 'payout_released' | 'refund_initiated' | 'refund_paid'
  | 'clawback_written_off' | 'chargeback_received' | 'duplicate_payment' | 'goodwill_refund' | 'manual_adjustment';

export interface Journal {
  kind: JournalKind;
  memo: string;
  lines: LedgerLine[];
}

export class UnbalancedJournalError extends Error {}

export function assertBalanced(j: Journal): void {
  const byCurrency = new Map<string, number>();
  for (const l of j.lines) {
    if (l.amount.minor < 0) throw new UnbalancedJournalError(`Negative line amount in ${j.kind}`);
    const cur = byCurrency.get(l.amount.currency) ?? 0;
    byCurrency.set(l.amount.currency, cur + (l.side === 'debit' ? l.amount.minor : -l.amount.minor));
  }
  for (const [c, net] of byCurrency) {
    if (net !== 0) throw new UnbalancedJournalError(`Journal ${j.kind} unbalanced in ${c} by ${net}`);
  }
}

function journal(kind: JournalKind, memo: string, lines: LedgerLine[]): Journal {
  const j: Journal = { kind, memo, lines: lines.filter(l => l.amount.minor !== 0) };
  assertBalanced(j);
  return j;
}

const dr = (account: LedgerAccount, amount: Money): LedgerLine => ({ account, side: 'debit', amount });
const cr = (account: LedgerAccount, amount: Money): LedgerLine => ({ account, side: 'credit', amount });

/** Posted when a verified MIPS success callback is processed. */
export function paymentCapturedJournal(b: FeeBreakdown): Journal {
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
export function payoutReleasedJournal(net: Money, clawbackRecovered: Money = money(0, net.currency)): Journal {
  if (clawbackRecovered.minor > net.minor) throw new Error('Cannot recover more than the payout');
  return journal('payout_released', 'Provider payout disbursed', [
    dr('provider_payable', net),
    cr('cash_settlement', sub(net, clawbackRecovered)),
    cr('provider_clawback_receivable', clawbackRecovered),
  ]);
}

/**
 * Settlement after a cancellation or dispute, expressed as an ADJUSTED agreed
 * amount: what the job is fairly worth after resolution. Fees are recomputed on
 * the adjusted amount so the platform fee and commission shrink proportionally.
 *
 *   refund_full          → adjustedAgreed = 0
 *   release_to_provider  → adjustedAgreed = agreed
 *   refund_partial/split → 0 < adjustedAgreed < agreed
 */
export interface Settlement {
  original: FeeBreakdown;
  adjusted: FeeBreakdown | null; // null when adjustedAgreed = 0
  refundToCustomer: Money;
  providerReduction: Money;
  feeReduction: Money;
  commissionReduction: Money;
  providerNetAfter: Money;
}

export function computeSettlement(original: FeeBreakdown, adjustedAgreed: Money): Settlement {
  const c = original.agreed.currency;
  if (adjustedAgreed.currency !== c) throw new Error('Currency mismatch');
  if (adjustedAgreed.minor < 0 || adjustedAgreed.minor > original.agreed.minor) {
    throw new Error('Adjusted amount must be between 0 and the original agreed amount');
  }
  const adjusted = adjustedAgreed.minor === 0
    ? null
    : computeFees(adjustedAgreed, { customerFeeBps: original.customerFeeBps, providerCommissionBps: original.providerCommissionBps });
  const z = money(0, c);
  const s: Settlement = {
    original,
    adjusted,
    refundToCustomer: sub(original.customerCharge, adjusted?.customerCharge ?? z),
    providerReduction: sub(original.providerNet, adjusted?.providerNet ?? z),
    feeReduction: sub(original.customerFee, adjusted?.customerFee ?? z),
    commissionReduction: sub(original.providerCommission, adjusted?.providerCommission ?? z),
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
export function refundInitiatedJournal(s: Settlement, payoutAlreadyReleased: boolean): Journal {
  return journal('refund_initiated', payoutAlreadyReleased ? 'Refund approved after payout; provider clawback opened' : 'Refund approved', [
    dr('platform_fee_revenue', s.feeReduction),
    dr('platform_commission_revenue', s.commissionReduction),
    dr(payoutAlreadyReleased ? 'provider_clawback_receivable' : 'provider_payable', s.providerReduction),
    cr('refund_liability', s.refundToCustomer),
  ]);
}

/** Posted when MIPS (or the alternate rail) confirms the refund left the platform account. */
export function refundPaidJournal(amount: Money): Journal {
  return journal('refund_paid', 'Refund paid to customer', [
    dr('refund_liability', amount),
    cr('cash_settlement', amount),
  ]);
}

/** Unrecoverable clawback absorbed by the platform reserve. */
export function clawbackWriteOffJournal(amount: Money): Journal {
  return journal('clawback_written_off', 'Uncollectable provider clawback written off to reserve', [
    dr('platform_reserve', amount),
    cr('provider_clawback_receivable', amount),
  ]);
}

/** Chargeback debited by the acquirer: cash leaves immediately; loss sits in reserve until evidence outcome. */
export function chargebackJournal(amount: Money): Journal {
  return journal('chargeback_received', 'Card chargeback debited by acquirer', [
    dr('platform_reserve', amount),
    cr('cash_settlement', amount),
  ]);
}

/** A second successful charge for an already-paid booking: hold as refund liability, refund in full. */
export function duplicatePaymentJournal(amount: Money): Journal {
  return journal('duplicate_payment', 'Duplicate customer payment received; to be refunded', [
    dr('cash_settlement', amount),
    cr('refund_liability', amount),
  ]);
}

/** Platform-funded goodwill refund (support/admin): provider's payout is untouched. */
export function goodwillRefundJournal(amount: Money): Journal {
  return journal('goodwill_refund', 'Goodwill refund funded by platform reserve', [
    dr('platform_reserve', amount),
    cr('refund_liability', amount),
  ]);
}

/** Natural-sign balance per account (positive = normal balance) from a list of lines. */
export function balances(lines: LedgerLine[], currency: string): Record<LedgerAccount, number> {
  const out = Object.fromEntries(LEDGER_ACCOUNTS.map(a => [a, 0])) as Record<LedgerAccount, number>;
  for (const l of lines) {
    if (l.amount.currency !== currency) continue;
    const signed = l.side === 'debit' ? l.amount.minor : -l.amount.minor;
    out[l.account] += DEBIT_NORMAL.has(l.account) ? signed : -signed;
  }
  return out;
}
