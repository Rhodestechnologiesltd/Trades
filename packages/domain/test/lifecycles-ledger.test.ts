import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BookingMachine, RequestMachine, QuoteMachine, PayoutMachine, DisputeMachine, PaymentMachine, CounterMachine, DispatchMachine,
  BOOKING_STATES, REQUEST_STATES, InvalidTransitionError,
  computeFees, PLATFORM_DEFAULT_FEES, fromMajor, money,
  paymentCapturedJournal, payoutReleasedJournal, computeSettlement, refundInitiatedJournal, refundPaidJournal,
  clawbackWriteOffJournal, balances, LedgerLine, assertBalanced, UnbalancedJournalError,
} from '../src';

test('booking happy path follows spec §C.5', () => {
  const path: Array<[string, string]> = [
    ['payment_captured', 'system'], ['assign', 'system'], ['start', 'provider'], ['complete', 'provider'],
    ['approve', 'customer'], ['schedule_payout', 'system'], ['release_payout', 'system'],
  ];
  let s: any = 'payment_pending';
  for (const [t, a] of path) s = BookingMachine.next(s, t as any, a as any);
  assert.equal(s, 'payout_released');
});

test('client cannot mark a payment captured; only the system (verified webhook) can', () => {
  assert.throws(() => BookingMachine.next('payment_pending', 'payment_captured', 'customer'), InvalidTransitionError);
});

test('customer cannot start a job, provider cannot approve their own job', () => {
  assert.throws(() => BookingMachine.next('assigned', 'start', 'customer'));
  assert.throws(() => BookingMachine.next('completed_by_provider', 'approve', 'provider'));
  assert.equal(BookingMachine.next('completed_by_provider', 'auto_approve', 'system'), 'approved_by_customer');
});

test('disputes freeze payout and can be raised even after release (clawback path)', () => {
  assert.equal(BookingMachine.next('payout_pending', 'dispute', 'customer'), 'disputed');
  assert.equal(BookingMachine.next('payout_released', 'dispute', 'customer'), 'disputed');
  assert.equal(BookingMachine.next('disputed', 'resolve_refund', 'admin'), 'refund_pending');
  assert.throws(() => BookingMachine.next('disputed', 'resolve_refund', 'customer'));
  assert.throws(() => BookingMachine.next('payment_pending', 'dispute', 'customer'));
});

test('cancel after payment leads to refund, cannot cancel once completed', () => {
  assert.equal(BookingMachine.next('assigned', 'cancel', 'customer'), 'cancelled');
  assert.equal(BookingMachine.next('cancelled', 'initiate_refund', 'system'), 'refund_pending');
  assert.equal(BookingMachine.next('refund_pending', 'refund_processed', 'system'), 'refunded');
  assert.throws(() => BookingMachine.next('completed_by_provider', 'cancel', 'customer'));
  assert.ok(BookingMachine.isTerminal('refunded'));
});

test('every state is reachable from the initial state', () => {
  assert.equal(BookingMachine.reachableFrom('payment_pending').size, BOOKING_STATES.length);
  assert.equal(RequestMachine.reachableFrom('draft').size, REQUEST_STATES.length);
});

test('other machines enforce actors', () => {
  assert.equal(RequestMachine.next('dispatched', 'expand_radius', 'system'), 'matching');
  assert.equal(QuoteMachine.next('active', 'counter', 'customer'), 'countered');
  assert.throws(() => QuoteMachine.next('active', 'withdraw', 'customer'));
  assert.equal(PayoutMachine.next('payout_pending', 'claim', 'system'), 'processing');
  assert.throws(() => PayoutMachine.next('released', 'claim', 'system')); // cannot re-claim → no double payout
  assert.throws(() => PayoutMachine.next('held', 'unhold', 'support'));
  assert.equal(DisputeMachine.next('opened', 'resolve', 'support'), 'resolved');
  assert.equal(PaymentMachine.next('intent_created', 'capture', 'system'), 'captured');
  assert.throws(() => CounterMachine.next('accepted', 'reject', 'provider'));
  assert.deepEqual(DispatchMachine.available('notified', 'provider').sort(), ['decline', 'quote', 'view']);
});

function post(lines: LedgerLine[], ...js: { lines: LedgerLine[] }[]) { for (const j of js) lines.push(...j.lines); }

test('ledger: capture then payout leaves provider_payable at zero and cash = platform revenue', () => {
  const b = computeFees(fromMajor('2000.00', 'MUR'), PLATFORM_DEFAULT_FEES);
  const lines: LedgerLine[] = [];
  post(lines, paymentCapturedJournal(b));
  let bal = balances(lines, 'MUR');
  assert.equal(bal.cash_settlement, 230000);
  assert.equal(bal.provider_payable, 170000);
  post(lines, payoutReleasedJournal(b.providerNet));
  bal = balances(lines, 'MUR');
  assert.equal(bal.provider_payable, 0);
  assert.equal(bal.cash_settlement, 60000);
  assert.equal(bal.platform_fee_revenue + bal.platform_commission_revenue, 60000);
});

test('ledger: full refund before payout returns everything and zeroes all accounts', () => {
  const b = computeFees(fromMajor('1234.56', 'MUR'), PLATFORM_DEFAULT_FEES);
  const s = computeSettlement(b, money(0, 'MUR'));
  assert.equal(s.refundToCustomer.minor, b.customerCharge.minor);
  const lines: LedgerLine[] = [];
  post(lines, paymentCapturedJournal(b), refundInitiatedJournal(s, false), refundPaidJournal(s.refundToCustomer));
  const bal = balances(lines, 'MUR');
  for (const v of Object.values(bal)) assert.equal(v, 0);
});

test('ledger: partial refund shrinks fees proportionally and conserves money', () => {
  const b = computeFees(fromMajor('2000.00', 'MUR'), PLATFORM_DEFAULT_FEES);
  const s = computeSettlement(b, fromMajor('1500.00', 'MUR'));
  assert.equal(s.refundToCustomer.minor, 57500); // 2300 - 1725
  assert.equal(s.providerNetAfter.minor, 127500); // 1500 × 0.85
  const lines: LedgerLine[] = [];
  post(lines, paymentCapturedJournal(b), refundInitiatedJournal(s, false), refundPaidJournal(s.refundToCustomer), payoutReleasedJournal(s.providerNetAfter));
  const bal = balances(lines, 'MUR');
  assert.equal(bal.provider_payable, 0);
  assert.equal(bal.refund_liability, 0);
  assert.equal(bal.cash_settlement, bal.platform_fee_revenue + bal.platform_commission_revenue);
  assert.equal(bal.cash_settlement, 45000); // 1500 × 0.30
});

test('ledger: refund after payout opens a clawback receivable, recovered from next payout', () => {
  const b = computeFees(fromMajor('1000.00', 'MUR'), PLATFORM_DEFAULT_FEES);
  const lines: LedgerLine[] = [];
  post(lines, paymentCapturedJournal(b), payoutReleasedJournal(b.providerNet));
  const s = computeSettlement(b, money(0, 'MUR'));
  post(lines, refundInitiatedJournal(s, true), refundPaidJournal(s.refundToCustomer));
  let bal = balances(lines, 'MUR');
  assert.equal(bal.provider_clawback_receivable, 85000);
  assert.equal(bal.cash_settlement, -85000); // platform fronted the provider's share
  // Next job of 1000: recover 425 (50% cap) from its 850 payout
  const b2 = computeFees(fromMajor('1000.00', 'MUR'), PLATFORM_DEFAULT_FEES);
  post(lines, paymentCapturedJournal(b2), payoutReleasedJournal(b2.providerNet, money(42500, 'MUR')));
  bal = balances(lines, 'MUR');
  assert.equal(bal.provider_clawback_receivable, 42500);
  post(lines, clawbackWriteOffJournal(money(42500, 'MUR')));
  bal = balances(lines, 'MUR');
  assert.equal(bal.provider_clawback_receivable, 0);
});

test('unbalanced journals are rejected', () => {
  assert.throws(() => assertBalanced({ kind: 'manual_adjustment', memo: '', lines: [{ account: 'cash_settlement', side: 'debit', amount: money(1, 'MUR') }] }), UnbalancedJournalError);
});
