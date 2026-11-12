import { ActorType, StateMachine } from './state-machine';

const HUMAN_STAFF: ActorType[] = ['admin', 'support', 'finance'];
const ALL_STAFF: ActorType[] = ['admin', 'support', 'finance', 'system'];

/* ───────────────────────── C.1 Service Request ───────────────────────── */

export const REQUEST_STATES = ['draft', 'requested', 'matching', 'dispatched', 'quoted', 'accepted', 'expired', 'cancelled'] as const;
export type RequestState = typeof REQUEST_STATES[number];
export type RequestTrigger =
  | 'submit' | 'abandon' | 'start_matching' | 'providers_found' | 'no_providers'
  | 'quote_received' | 'expand_radius' | 'sla_timeout' | 'accept_quote' | 'instant_assign'
  | 'all_quotes_lapsed' | 'expire' | 'cancel';

export const RequestMachine = new StateMachine<RequestState, RequestTrigger>(
  'service_request',
  REQUEST_STATES,
  ['accepted', 'expired', 'cancelled'],
  [
    { from: 'draft', to: 'requested', trigger: 'submit', actors: ['customer', 'system'] },
    { from: 'draft', to: 'cancelled', trigger: 'abandon', actors: ['system', 'customer'] },
    { from: 'requested', to: 'matching', trigger: 'start_matching', actors: ['system'] },
    { from: 'matching', to: 'dispatched', trigger: 'providers_found', actors: ['system'] },
    { from: 'matching', to: 'expired', trigger: 'no_providers', actors: ['system'], description: 'max radius reached, nobody eligible' },
    { from: 'dispatched', to: 'quoted', trigger: 'quote_received', actors: ['provider', 'system'] },
    { from: 'dispatched', to: 'matching', trigger: 'expand_radius', actors: ['system', 'admin'], description: 'radius auto-expansion (§G.2)' },
    { from: 'dispatched', to: 'expired', trigger: 'sla_timeout', actors: ['system'] },
    { from: 'dispatched', to: 'accepted', trigger: 'instant_assign', actors: ['system'], description: 'urgent instant-accept pricing (§G.4)' },
    { from: 'quoted', to: 'accepted', trigger: 'accept_quote', actors: ['customer', 'system'], description: 'system = recurring pre-agreed rate' },
    { from: 'quoted', to: 'dispatched', trigger: 'all_quotes_lapsed', actors: ['system'] },
    { from: 'quoted', to: 'expired', trigger: 'expire', actors: ['system'] },
    { from: ['requested', 'matching', 'dispatched', 'quoted'], to: 'cancelled', trigger: 'cancel', actors: ['customer', 'admin', 'support', 'system'] },
  ],
);

/* ─────────────────── C.2 Provider dispatch (per candidate) ─────────────────── */

export const DISPATCH_STATES = ['candidate_identified', 'notified', 'viewed', 'quoted', 'declined', 'expired_no_response', 'closed'] as const;
export type DispatchState = typeof DISPATCH_STATES[number];
export type DispatchTrigger = 'notify' | 'view' | 'quote' | 'decline' | 'timeout' | 'close';

export const DispatchMachine = new StateMachine<DispatchState, DispatchTrigger>(
  'provider_dispatch',
  DISPATCH_STATES,
  ['quoted', 'declined', 'expired_no_response', 'closed'],
  [
    { from: 'candidate_identified', to: 'notified', trigger: 'notify', actors: ['system'] },
    { from: 'notified', to: 'viewed', trigger: 'view', actors: ['provider'] },
    { from: ['notified', 'viewed'], to: 'quoted', trigger: 'quote', actors: ['provider'] },
    { from: ['notified', 'viewed'], to: 'declined', trigger: 'decline', actors: ['provider'] },
    { from: ['notified', 'viewed'], to: 'expired_no_response', trigger: 'timeout', actors: ['system'] },
    { from: ['candidate_identified', 'notified', 'viewed'], to: 'closed', trigger: 'close', actors: ['system'] },
  ],
);

/* ───────────────────────────── C.3 Quote ───────────────────────────── */

export const QUOTE_STATES = ['submitted', 'active', 'countered', 'accepted', 'expired', 'withdrawn', 'closed'] as const;
export type QuoteState = typeof QUOTE_STATES[number];
export type QuoteTrigger = 'publish' | 'counter' | 'counter_rejected' | 'counter_accepted' | 'accept' | 'expire' | 'withdraw' | 'close';

export const QuoteMachine = new StateMachine<QuoteState, QuoteTrigger>(
  'quote',
  QUOTE_STATES,
  ['accepted', 'expired', 'withdrawn', 'closed'],
  [
    { from: 'submitted', to: 'active', trigger: 'publish', actors: ['system'] },
    { from: 'active', to: 'countered', trigger: 'counter', actors: ['customer'] },
    { from: 'countered', to: 'active', trigger: 'counter_rejected', actors: ['customer', 'provider', 'system'], description: 'negotiation ended without agreement; last provider offer stands' },
    { from: 'countered', to: 'accepted', trigger: 'counter_accepted', actors: ['customer', 'provider'] },
    { from: 'active', to: 'accepted', trigger: 'accept', actors: ['customer', 'system'] },
    { from: ['submitted', 'active', 'countered'], to: 'expired', trigger: 'expire', actors: ['system'] },
    { from: ['submitted', 'active', 'countered'], to: 'withdrawn', trigger: 'withdraw', actors: ['provider'] },
    { from: ['submitted', 'active', 'countered'], to: 'closed', trigger: 'close', actors: ['system'], description: 'another quote won or request cancelled' },
  ],
);

/* ─────────────────────────── C.4 Counter-offer ─────────────────────────── */

export const COUNTER_STATES = ['proposed', 'accepted', 'rejected', 'expired', 'countered'] as const;
export type CounterState = typeof COUNTER_STATES[number];
export type CounterTrigger = 'accept' | 'reject' | 'counter' | 'expire';

export const CounterMachine = new StateMachine<CounterState, CounterTrigger>(
  'counter_offer',
  COUNTER_STATES,
  ['accepted', 'rejected', 'expired', 'countered'],
  [
    { from: 'proposed', to: 'accepted', trigger: 'accept', actors: ['customer', 'provider'] },
    { from: 'proposed', to: 'rejected', trigger: 'reject', actors: ['customer', 'provider'] },
    { from: 'proposed', to: 'countered', trigger: 'counter', actors: ['customer', 'provider'] },
    { from: 'proposed', to: 'expired', trigger: 'expire', actors: ['system'] },
  ],
);

/* ───────────────────── C.5 Booking (master lifecycle) ───────────────────── */

export const BOOKING_STATES = [
  'payment_pending', 'payment_authorized', 'assigned', 'in_progress', 'completed_by_provider',
  'approved_by_customer', 'payout_pending', 'payout_released', 'cancelled', 'disputed',
  'refund_pending', 'refunded',
] as const;
export type BookingState = typeof BOOKING_STATES[number];
export type BookingTrigger =
  | 'payment_captured' | 'payment_window_expired' | 'assign' | 'start' | 'complete' | 'approve'
  | 'auto_approve' | 'schedule_payout' | 'release_payout' | 'cancel' | 'no_show' | 'initiate_refund'
  | 'refund_processed' | 'refund_processed_partial' | 'dispute'
  | 'resolve_release' | 'resolve_refund' | 'resolve_keep_released';

export const BookingMachine = new StateMachine<BookingState, BookingTrigger>(
  'booking',
  BOOKING_STATES,
  ['refunded'],
  [
    { from: 'payment_pending', to: 'payment_authorized', trigger: 'payment_captured', actors: ['system'], description: 'only from verified MIPS webhook / verify call' },
    { from: 'payment_pending', to: 'cancelled', trigger: 'payment_window_expired', actors: ['system'] },
    { from: 'payment_authorized', to: 'assigned', trigger: 'assign', actors: ['system'] },
    { from: 'assigned', to: 'in_progress', trigger: 'start', actors: ['provider'] },
    { from: 'assigned', to: 'cancelled', trigger: 'no_show', actors: ['system', 'customer', 'admin', 'support'] },
    { from: 'in_progress', to: 'completed_by_provider', trigger: 'complete', actors: ['provider'] },
    { from: 'completed_by_provider', to: 'approved_by_customer', trigger: 'approve', actors: ['customer'] },
    { from: 'completed_by_provider', to: 'approved_by_customer', trigger: 'auto_approve', actors: ['system'] },
    { from: 'approved_by_customer', to: 'payout_pending', trigger: 'schedule_payout', actors: ['system'] },
    { from: 'payout_pending', to: 'payout_released', trigger: 'release_payout', actors: ['system', 'finance', 'admin'] },
    { from: 'payment_pending', to: 'cancelled', trigger: 'cancel', actors: ['customer', 'admin', 'support', 'system'] },
    { from: ['payment_authorized', 'assigned'], to: 'cancelled', trigger: 'cancel', actors: ['customer', 'provider', 'admin', 'support'] },
    { from: 'in_progress', to: 'cancelled', trigger: 'cancel', actors: ['admin', 'support'] },
    { from: 'cancelled', to: 'refund_pending', trigger: 'initiate_refund', actors: ['system', ...HUMAN_STAFF] },
    { from: 'refund_pending', to: 'refunded', trigger: 'refund_processed', actors: ['system'] },
    { from: 'refund_pending', to: 'payout_pending', trigger: 'refund_processed_partial', actors: ['system'], description: 'split settlement: remainder goes to provider' },
    {
      from: ['in_progress', 'completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released'],
      to: 'disputed', trigger: 'dispute', actors: ['customer', 'provider', 'system', 'support', 'admin'],
    },
    { from: 'disputed', to: 'payout_pending', trigger: 'resolve_release', actors: HUMAN_STAFF },
    { from: 'disputed', to: 'refund_pending', trigger: 'resolve_refund', actors: HUMAN_STAFF },
    { from: 'disputed', to: 'payout_released', trigger: 'resolve_keep_released', actors: HUMAN_STAFF },
  ],
);

/** States in which the provider may see the exact customer address (§G.7). */
export const EXACT_LOCATION_VISIBLE_STATES: readonly BookingState[] = [
  'payment_authorized', 'assigned', 'in_progress', 'completed_by_provider',
];

/** States in which the customer may see the provider's live location (§G.7). */
export const LIVE_TRACKING_STATES: readonly BookingState[] = ['assigned', 'in_progress'];

/* ───────────────────────────── C.6 Payment ───────────────────────────── */

export const PAYMENT_STATES = ['intent_created', 'authorized', 'captured', 'failed', 'refund_initiated', 'partially_refunded', 'refunded'] as const;
export type PaymentState = typeof PAYMENT_STATES[number];
export type PaymentTrigger = 'authorize' | 'capture' | 'fail' | 'initiate_refund' | 'refund_succeeded' | 'refund_partial_succeeded' | 'refund_failed';

export const PaymentMachine = new StateMachine<PaymentState, PaymentTrigger>(
  'payment',
  PAYMENT_STATES,
  ['failed', 'refunded'],
  [
    { from: 'intent_created', to: 'authorized', trigger: 'authorize', actors: ['system'] },
    { from: ['intent_created', 'authorized'], to: 'captured', trigger: 'capture', actors: ['system'] },
    { from: ['intent_created', 'authorized'], to: 'failed', trigger: 'fail', actors: ['system'] },
    { from: ['captured', 'partially_refunded'], to: 'refund_initiated', trigger: 'initiate_refund', actors: ['system', ...HUMAN_STAFF] },
    { from: 'refund_initiated', to: 'refunded', trigger: 'refund_succeeded', actors: ['system'] },
    { from: 'refund_initiated', to: 'partially_refunded', trigger: 'refund_partial_succeeded', actors: ['system'] },
    { from: 'refund_initiated', to: 'captured', trigger: 'refund_failed', actors: ['system'] },
  ],
);

/* ───────────────────────────── C.8 Payout ───────────────────────────── */

export const PAYOUT_STATES = ['payout_pending', 'processing', 'released', 'settled', 'held', 'clawed_back', 'cancelled'] as const;
export type PayoutState = typeof PAYOUT_STATES[number];
export type PayoutTrigger = 'claim' | 'disbursed' | 'disbursement_failed' | 'settle' | 'hold' | 'unhold' | 'cancel' | 'clawback';

export const PayoutMachine = new StateMachine<PayoutState, PayoutTrigger>(
  'payout',
  PAYOUT_STATES,
  ['cancelled', 'clawed_back'],
  [
    { from: 'payout_pending', to: 'processing', trigger: 'claim', actors: ['system', 'finance', 'admin'] },
    { from: 'processing', to: 'released', trigger: 'disbursed', actors: ['system'] },
    { from: 'processing', to: 'payout_pending', trigger: 'disbursement_failed', actors: ['system'] },
    { from: 'released', to: 'settled', trigger: 'settle', actors: ['system', 'finance'] },
    { from: 'payout_pending', to: 'held', trigger: 'hold', actors: ALL_STAFF },
    { from: 'held', to: 'payout_pending', trigger: 'unhold', actors: ['finance', 'admin'] },
    { from: ['payout_pending', 'held'], to: 'cancelled', trigger: 'cancel', actors: ALL_STAFF },
    { from: ['released', 'settled'], to: 'clawed_back', trigger: 'clawback', actors: ['system', 'finance', 'admin'] },
  ],
);

/* ───────────────────────────── C.9 Dispute ───────────────────────────── */

export const DISPUTE_STATES = ['opened', 'under_review', 'awaiting_evidence', 'resolved', 'closed'] as const;
export type DisputeState = typeof DISPUTE_STATES[number];
export type DisputeTrigger = 'start_review' | 'request_evidence' | 'evidence_submitted' | 'evidence_deadline' | 'resolve' | 'close' | 'withdraw';

export const DisputeMachine = new StateMachine<DisputeState, DisputeTrigger>(
  'dispute',
  DISPUTE_STATES,
  ['closed'],
  [
    { from: 'opened', to: 'under_review', trigger: 'start_review', actors: ALL_STAFF },
    { from: 'under_review', to: 'awaiting_evidence', trigger: 'request_evidence', actors: HUMAN_STAFF },
    { from: 'awaiting_evidence', to: 'under_review', trigger: 'evidence_submitted', actors: ['customer', 'provider'] },
    { from: 'awaiting_evidence', to: 'under_review', trigger: 'evidence_deadline', actors: ['system'] },
    { from: ['opened', 'under_review', 'awaiting_evidence'], to: 'resolved', trigger: 'resolve', actors: HUMAN_STAFF },
    { from: 'resolved', to: 'closed', trigger: 'close', actors: ['system', 'admin'] },
    { from: ['opened', 'under_review', 'awaiting_evidence'], to: 'closed', trigger: 'withdraw', actors: ['customer', 'provider'] },
  ],
);

export type DisputeReason = 'no_show' | 'incomplete_work' | 'damage' | 'overcharge' | 'unsafe_conduct' | 'other';
export type DisputeResolution = 'refund_full' | 'refund_partial' | 'release_to_provider' | 'split';

/** Target resolution SLA per reason code, in hours (§C.9). */
export const DISPUTE_SLA_HOURS: Record<DisputeReason, number> = {
  no_show: 24,
  unsafe_conduct: 12,
  damage: 72,
  incomplete_work: 72,
  overcharge: 48,
  other: 72,
};

/** Which staff role queue a dispute routes to by default (§A.10 playbooks / §I). */
export const DISPUTE_ROUTING: Record<DisputeReason, 'support' | 'admin' | 'finance'> = {
  no_show: 'support',
  incomplete_work: 'support',
  damage: 'admin',
  overcharge: 'finance',
  unsafe_conduct: 'admin',
  other: 'support',
};

/* ─────────────────────── Recurring agreement (§A.3, §G.5) ─────────────────────── */

export const RECURRING_STATES = ['active', 'paused', 'cancelled'] as const;
export type RecurringState = typeof RECURRING_STATES[number];
export const RecurringMachine = new StateMachine<RecurringState, 'pause' | 'resume' | 'cancel'>(
  'recurring_agreement',
  RECURRING_STATES,
  ['cancelled'],
  [
    { from: 'active', to: 'paused', trigger: 'pause', actors: ['customer', 'admin'] },
    { from: 'paused', to: 'active', trigger: 'resume', actors: ['customer', 'admin'] },
    { from: ['active', 'paused'], to: 'cancelled', trigger: 'cancel', actors: ['customer', 'provider', 'admin'] },
  ],
);
