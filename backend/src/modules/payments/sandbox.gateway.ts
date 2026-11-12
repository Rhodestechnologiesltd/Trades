import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../../common/config';
import { hmacSha256, safeEqual } from '../../common/crypto';
import { CreateSessionInput, CreateSessionResult, DisbursementInput, DisbursementRail, DisbursementResult, NormalizedGatewayEvent, PaymentGateway, RefundInput, RefundResult } from './gateway';

export const SANDBOX_SECRET = 'sandbox-webhook-secret';

/**
 * Development/test gateway. Hosts a fake payment page (see SandboxController) and
 * emits HMAC-signed callbacks exactly like a real gateway would, so the full
 * webhook → capture → ledger path is exercised end-to-end. Disabled in production.
 */
@Injectable()
export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox';
  private readonly sessions = new Map<string, { paymentId: string; amount: string; currency: string; returnUrl: string; outcome?: 'succeeded' | 'failed' }>();
  private readonly refunds = new Map<string, RefundResult>();

  async createSession(i: CreateSessionInput): Promise<CreateSessionResult> {
    const sessionId = `sbx_${randomUUID()}`;
    this.sessions.set(sessionId, { paymentId: i.paymentId, amount: i.amount, currency: i.currency, returnUrl: i.returnUrl });
    return { sessionId, redirectUrl: `${config.publicApiUrl}/v1/payments/sandbox/${sessionId}`, expiresAt: new Date(Date.now() + 30 * 60_000) };
  }

  session(id: string) { return this.sessions.get(id); }

  /** Builds the signed callback the sandbox "acquirer" sends. */
  buildCallback(sessionId: string, outcome: 'succeeded' | 'failed') {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('unknown session');
    s.outcome = outcome;
    const body = {
      event_id: `evt_${randomUUID()}`, type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', order_id: s.paymentId,
      transaction_id: `txn_${sessionId.slice(4, 16)}`, amount: s.amount, currency: s.currency, card_brand: 'VISA', card_last4: '4242',
      failure_code: outcome === 'failed' ? 'card_declined' : undefined,
    };
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, body, signature: hmacSha256(SANDBOX_SECRET, raw.toString('utf8')), returnUrl: s.returnUrl };
  }

  async parseWebhook(headers: Record<string, any>, rawBody: Buffer, body: any): Promise<NormalizedGatewayEvent | null> {
    const sig = String(headers['x-sandbox-signature'] ?? '');
    if (!sig || !safeEqual(sig, hmacSha256(SANDBOX_SECRET, rawBody.toString('utf8')))) return null;
    return {
      eventId: body.event_id, type: body.type, paymentId: body.order_id, gatewayReference: body.transaction_id,
      amount: body.amount, currency: body.currency, cardBrand: body.card_brand, cardLast4: body.card_last4,
      failureCode: body.failure_code, raw: body,
    };
  }

  async fetchStatus(paymentId: string): Promise<NormalizedGatewayEvent | null> {
    for (const [id, s] of this.sessions) {
      if (s.paymentId === paymentId && s.outcome) {
        return { eventId: `poll_${id}`, type: s.outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', paymentId, gatewayReference: `txn_${id.slice(4, 16)}`, amount: s.amount, currency: s.currency, raw: { polled: true } };
      }
    }
    return null;
  }

  async refund(i: RefundInput): Promise<RefundResult> {
    const prev = this.refunds.get(i.idempotencyKey);
    if (prev) return prev;
    const r: RefundResult = { status: 'succeeded', refundReference: `rf_${randomUUID().slice(0, 12)}` };
    this.refunds.set(i.idempotencyKey, r);
    return r;
  }
}

@Injectable()
export class SandboxDisbursementRail implements DisbursementRail {
  readonly name = 'sandbox';
  private readonly done = new Map<string, DisbursementResult>();
  async disburse(i: DisbursementInput): Promise<DisbursementResult> {
    const prev = this.done.get(i.idempotencyKey);
    if (prev) return prev;
    const r: DisbursementResult = { status: 'succeeded', reference: `po_${randomUUID().slice(0, 12)}` };
    this.done.set(i.idempotencyKey, r);
    return r;
  }
  async status(key: string) { return this.done.get(key) ?? null; }
}

/**
 * Manual bank-file rail for launch: payouts are marked 'pending' and exported by
 * Finance as a bank bulk-transfer file from the admin dashboard; Finance confirms
 * completion, which marks them released. Status lookups return null (unknown) so
 * the reconciliation sweep leaves them for Finance rather than re-disbursing.
 */
@Injectable()
export class ManualBankFileRail implements DisbursementRail {
  readonly name = 'manual_bank_file';
  async disburse(): Promise<DisbursementResult> { return { status: 'pending' }; }
  async status(): Promise<DisbursementResult | null> { return null; }
}
