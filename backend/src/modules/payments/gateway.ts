/**
 * Payment Provider Interface (spec §0, §F.1). MIPS is the launch adapter; Stripe/Adyen
 * or other local switches plug in here without touching booking or ledger logic.
 */
export interface CreateSessionInput {
  paymentId: string;            // our id — used as the gateway order id
  bookingReference: string;
  amount: string;               // decimal string, major units
  currency: string;
  customer: { name: string; email?: string | null; phone?: string | null };
  returnUrl: string;
  idempotencyKey: string;
  locale?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  /** URL the client opens (hosted payment page / our wrapper page around an iframe). */
  redirectUrl: string;
  expiresAt?: Date;
}

export type GatewayEventType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed' | 'chargeback.opened';

export interface NormalizedGatewayEvent {
  eventId: string;              // unique per gateway event (dedupe key)
  type: GatewayEventType;
  paymentId: string;            // our payment id (order id)
  gatewayReference?: string;    // gateway transaction id
  amount?: string;
  currency?: string;
  cardBrand?: string;
  cardLast4?: string;
  failureCode?: string;
  failureMessage?: string;
  refundReference?: string;
  chargebackReference?: string;
  chargebackRespondBy?: string;
  raw: unknown;
}

export interface RefundInput { paymentId: string; gatewayReference: string; amount: string; currency: string; idempotencyKey: string; reason: string }
export interface RefundResult { status: 'succeeded' | 'pending' | 'failed' | 'unsupported'; refundReference?: string; error?: string }

export interface PaymentGateway {
  readonly name: string;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  /** Authenticate + parse a server-to-server callback. Return null when it cannot be authenticated. */
  parseWebhook(headers: Record<string, any>, rawBody: Buffer, body: any): Promise<NormalizedGatewayEvent | null>;
  /** Poll the authoritative status (fallback when a webhook is delayed). */
  fetchStatus(paymentId: string, gatewayReference?: string | null): Promise<NormalizedGatewayEvent | null>;
  refund(input: RefundInput): Promise<RefundResult>;
}

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/** Payout rail abstraction (bank transfer / mobile wallet / future MIPS disbursement). */
export interface DisbursementInput { idempotencyKey: string; amount: string; currency: string; account: { method: string; holderName: string; details: { accountNumber: string; bankCode?: string | null } }; reference: string }
export interface DisbursementResult { status: 'succeeded' | 'pending' | 'failed'; reference?: string; error?: string }
export interface DisbursementRail {
  readonly name: string;
  disburse(input: DisbursementInput): Promise<DisbursementResult>;
  /** Look up a previous disbursement by idempotency key (reconciliation sweep, §F.4). */
  status(idempotencyKey: string): Promise<DisbursementResult | null>;
}
export const DISBURSEMENT_RAIL = Symbol('DISBURSEMENT_RAIL');
