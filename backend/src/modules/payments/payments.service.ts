import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BookingMachine, PaymentMachine, Settlement, breakdownFromFrozen, chargebackJournal, computeSettlement, duplicatePaymentJournal, money,
  paymentCapturedJournal, refundInitiatedJournal, refundPaidJournal, DEFAULT_ABUSE_LIMITS,
} from '@trades/domain';
import { Actor, SYSTEM_ACTOR } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { config } from '../../common/config';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { StateService } from '../../common/state.service';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutsService } from '../payouts/payouts.service';
import { NormalizedGatewayEvent, PAYMENT_GATEWAYS, PaymentGateway } from './gateway';

/**
 * Payment/Ledger service (§F). Highest-trust component:
 *  - the authoritative "paid" transition happens ONLY from an authenticated gateway
 *    callback (or a server-side status poll) — never from a client signal
 *  - "hold" = platform-ledger virtual hold: MIPS settles to the platform account,
 *    provider share sits in provider_payable until the T+48h payout
 *  - every callback is deduplicated by (gateway, event_id) and every journal by key
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cfg: PlatformConfigService,
    private readonly limits: RateLimitService,
    private readonly payouts: PayoutsService,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: Record<string, PaymentGateway>,
  ) {}

  private gateway(name: string): PaymentGateway {
    const g = this.gateways[name];
    if (!g) throw new Error(`Payment gateway ${name} not configured`);
    return g;
  }

  /** POST /v1/bookings/:id/payment — creates a payment intent + hosted session. */
  async initiate(actor: Actor, bookingId: string, returnUrl?: string) {
    const abuse = await this.cfg.abuse().catch(() => DEFAULT_ABUSE_LIMITS);
    // Per-booking attempt cap (declines/card testing) + a looser per-customer velocity cap (§J).
    await this.limits.enforce(`pay:${actor.userId}:${bookingId}`, abuse.maxPaymentAttemptsPerCustomerPerHour, 3600, 'Too many payment attempts. Please wait and try again.');
    await this.limits.enforce(`pay:${actor.userId}`, abuse.maxPaymentAttemptsPerCustomerPerHour * 4, 3600, 'Too many payment attempts. Please wait and try again.');
    const prepared = await this.db.tx(async c => {
      const b = await this.db.one(
        `SELECT b.*, mk.payment_gateway, u.full_name, u.email, u.phone_number, u.locale FROM bookings b JOIN markets mk ON mk.id = b.market_id
           JOIN users u ON u.id = b.customer_id WHERE b.id = $1 FOR UPDATE OF b`, [bookingId], c);
      if (!b) throw new NotFoundError('Booking not found');
      if (b.customer_id !== actor.userId) throw new ForbiddenError();
      if (b.status !== 'payment_pending') throw new ConflictError(`This booking is ${b.status.replace(/_/g, ' ')} and cannot be paid`, 'invalid_state');
      if (new Date(b.payment_due_at) < new Date()) throw new ConflictError('The payment window for this booking has closed', 'payment_window_closed');
      const fees = breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code,
        (await this.db.one(`SELECT fee_bps FROM platform_fees WHERE booking_id = $1`, [b.id], c))!.fee_bps,
        (await this.db.one(`SELECT commission_bps FROM platform_commissions WHERE booking_id = $1`, [b.id], c))!.commission_bps);
      // Reuse a fresh open intent (double-tap / app resume) instead of creating another.
      const open = await this.db.one(
        `SELECT * FROM payments WHERE booking_id = $1 AND status = 'intent_created' AND created_at > now() - interval '25 minutes' ORDER BY attempt DESC LIMIT 1`, [b.id], c);
      if (open?.gateway_session_id) return { reuse: open, booking: b, fees };
      const gatewayName = config.isProd ? b.payment_gateway : config.payment.gateway === 'mips' ? 'mips' : 'sandbox';
      const attempt = ((await this.db.one(`SELECT COALESCE(MAX(attempt),0)::int AS a FROM payments WHERE booking_id = $1`, [b.id], c))!.a) + 1;
      const p = await this.db.one(
        `INSERT INTO payments (booking_id, attempt, gateway, amount_charged_to_customer, currency_code, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.id, attempt, gatewayName, n(fees.customerCharge), b.currency_code, `pay:${b.id}:${attempt}`], c);
      await this.state.created(c, 'payment', p!.id, 'intent_created', actor, { attempt });
      return { reuse: null, payment: p!, booking: b, fees };
    });
    const b = prepared.booking;
    const breakdown = {
      agreedAmount: n(prepared.fees.agreed), platformFee: n(prepared.fees.customerFee), total: n(prepared.fees.customerCharge),
      feePct: (prepared.fees.customerFeeBps / 100).toFixed(2), currency: b.currency_code,
    };
    if (prepared.reuse) {
      return { paymentId: prepared.reuse.id, redirectUrl: prepared.reuse.gateway_session_id.startsWith('http') ? prepared.reuse.gateway_session_id : `${config.publicApiUrl}/v1/payments/${prepared.reuse.id}/resume`, breakdown };
    }
    const p = prepared.payment!;
    try {
      const session = await this.gateway(p.gateway).createSession({
        paymentId: p.id, bookingReference: b.reference, amount: p.amount_charged_to_customer, currency: p.currency_code,
        customer: { name: b.full_name, email: b.email, phone: b.phone_number },
        returnUrl: returnUrl ?? config.payment.mips.returnUrl, idempotencyKey: p.idempotency_key, locale: b.locale,
      });
      await this.db.pool.query(`UPDATE payments SET gateway_session_id = $2 WHERE id = $1`, [p.id, session.redirectUrl]);
      return { paymentId: p.id, redirectUrl: session.redirectUrl, expiresAt: session.expiresAt, breakdown };
    } catch (e: any) {
      this.log.error(`createSession failed for payment ${p.id}: ${e.message}`);
      await this.db.tx(c => this.state.transition(c, PaymentMachine, p.id, 'fail', SYSTEM_ACTOR, { set: { failure_code: 'gateway_unavailable', failure_message: e.message.slice(0, 300) } }));
      throw new ConflictError('The payment provider is temporarily unavailable. Please try again in a moment.', 'gateway_unavailable');
    }
  }

  /* ───────────── webhooks ───────────── */

  async handleWebhook(gatewayName: string, headers: Record<string, any>, raw: Buffer, body: any): Promise<{ ok: boolean; duplicate?: boolean }> {
    const gw = this.gateway(gatewayName);
    const evt = await gw.parseWebhook(headers, raw, body);
    if (!evt) {
      // Possible spoofed callback (§J monitoring): persist + alert, never act on it.
      await this.db.pool.query(
        `INSERT INTO payment_webhook_events (gateway, event_id, signature_valid, payload, error) VALUES ($1,$2,false,$3,'signature_invalid')
         ON CONFLICT DO NOTHING`, [gatewayName, `invalid:${Date.now()}:${Math.random()}`, JSON.stringify(body ?? {})]);
      this.log.warn(`Rejected unauthenticated ${gatewayName} webhook`);
      return { ok: false };
    }
    const inserted = await this.db.one(
      `INSERT INTO payment_webhook_events (gateway, event_id, signature_valid, payload) VALUES ($1,$2,true,$3)
       ON CONFLICT (gateway, event_id) DO NOTHING RETURNING id`, [gatewayName, evt.eventId, JSON.stringify(evt.raw ?? {})]);
    if (!inserted) {
      const prev = await this.db.one(`SELECT processed_at FROM payment_webhook_events WHERE gateway = $1 AND event_id = $2`, [gatewayName, evt.eventId]);
      if (prev?.processed_at) return { ok: true, duplicate: true };
    }
    try {
      await this.applyEvent(gatewayName, evt);
      await this.db.pool.query(`UPDATE payment_webhook_events SET processed_at = now(), error = NULL WHERE gateway = $1 AND event_id = $2`, [gatewayName, evt.eventId]);
      return { ok: true };
    } catch (e: any) {
      await this.db.pool.query(`UPDATE payment_webhook_events SET error = $3 WHERE gateway = $1 AND event_id = $2`, [gatewayName, evt.eventId, String(e.message).slice(0, 500)]);
      throw e; // non-2xx → gateway retries
    }
  }

  async applyEvent(gatewayName: string, evt: NormalizedGatewayEvent) {
    switch (evt.type) {
      case 'payment.succeeded': return this.capture(evt);
      case 'payment.failed': return this.fail(evt);
      case 'chargeback.opened': return this.chargeback(gatewayName, evt);
      default: return;
    }
  }

  private async capture(evt: NormalizedGatewayEvent) {
    let refundToProcess: string | null = null;
    await this.db.tx(async c => {
      const p = await this.db.one(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [evt.paymentId], c);
      if (!p) throw new NotFoundError(`Unknown payment ${evt.paymentId}`);
      if (['captured', 'refund_initiated', 'partially_refunded', 'refunded'].includes(p.status)) return; // idempotent replay
      // Amount/currency must match what we asked for — otherwise do not capture (possible tampering).
      if (evt.amount !== undefined && (m(evt.amount, p.currency_code).minor !== m(p.amount_charged_to_customer, p.currency_code).minor || (evt.currency && evt.currency !== p.currency_code))) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details)
                       SELECT customer_id, 'amount_mismatch', 5, id, $2 FROM bookings WHERE id = $1`, [p.booking_id, JSON.stringify({ expected: p.amount_charged_to_customer, got: evt.amount, currency: evt.currency })]);
        throw new ConflictError('Captured amount does not match payment intent', 'amount_mismatch');
      }
      const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [p.booking_id], c);
      const fees = breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code,
        (await this.db.one(`SELECT fee_bps FROM platform_fees WHERE booking_id = $1`, [b.id], c))!.fee_bps,
        (await this.db.one(`SELECT commission_bps FROM platform_commissions WHERE booking_id = $1`, [b.id], c))!.commission_bps);
      const details = { gateway_reference: evt.gatewayReference ?? null, card_brand: evt.cardBrand ?? null, card_last4: evt.cardLast4 ?? null, captured_at: new Date() };

      const alreadyPaid = await this.db.one(`SELECT id FROM payments WHERE booking_id = $1 AND id <> $2 AND status IN ('captured','partially_refunded')`, [b.id, p.id], c);
      if (alreadyPaid) {
        // Duplicate charge (two attempts both succeeded): record and refund in full.
        // Bypasses the one-live-capture index by recording the duplicate directly as refund_initiated.
        await c.query(`UPDATE payments SET status = 'refund_initiated', gateway_reference = $2, card_brand = $3, card_last4 = $4, captured_at = now() WHERE id = $1`,
          [p.id, details.gateway_reference, details.card_brand, details.card_last4]);
        await c.query(`INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, metadata)
                       VALUES ('payment',$1,$2,'refund_initiated','duplicate_capture','system','{}')`, [p.id, p.status]);
        await this.ledger.post(c, duplicatePaymentJournal(m(p.amount_charged_to_customer, p.currency_code)), {
          idempotencyKey: `duplicate_payment:${p.id}`, actor: SYSTEM_ACTOR, bookingId: b.id, referenceId: p.id, referenceType: 'payment' });
        refundToProcess = await this.insertRefundRow(c, b, p, m(p.amount_charged_to_customer, p.currency_code), m(b.agreed_amount, b.currency_code), 'Duplicate payment', SYSTEM_ACTOR, null, 'duplicate');
        return;
      }

      await this.state.transition(c, PaymentMachine, p.id, 'capture', SYSTEM_ACTOR, { set: details });
      await c.query(`INSERT INTO payment_holds (payment_id, booking_id, held_amount, currency_code) VALUES ($1,$2,$3,$4) ON CONFLICT (booking_id) DO NOTHING`,
        [p.id, b.id, n(fees.providerNet), b.currency_code]);
      await this.ledger.post(c, paymentCapturedJournal(fees), {
        idempotencyKey: `payment_captured:${p.id}`, actor: SYSTEM_ACTOR, bookingId: b.id, providerId: b.provider_id, referenceId: p.id, referenceType: 'payment' });

      if (b.status === 'payment_pending') {
        await this.state.transition(c, BookingMachine, b.id, 'payment_captured', SYSTEM_ACTOR);
        await this.state.transition(c, BookingMachine, b.id, 'assign', SYSTEM_ACTOR);
        const urgent = await this.db.one(`SELECT request_mode FROM service_requests WHERE id = $1`, [b.service_request_id], c);
        await c.query(`UPDATE providers SET current_active_jobs = current_active_jobs + 1, urgent_jobs_assigned = urgent_jobs_assigned + $2 WHERE id = $1`,
          [b.provider_id, urgent?.request_mode === 'urgent' ? 1 : 0]);
        await c.query(`INSERT INTO job_events (booking_id, event_type, payload) VALUES ($1,'assigned','{}')`, [b.id]);
        await this.outbox.emit(c, Events.PaymentCaptured, 'booking', b.id, {
          bookingId: b.id, reference: b.reference, customerId: b.customer_id, providerId: b.provider_id,
          charged: n(fees.customerCharge), agreed: n(fees.agreed), fee: n(fees.customerFee), currency: b.currency_code,
        }, b.market_id);
      } else {
        // Late success after the booking was cancelled (e.g. payment window expired) → refund in full.
        this.log.warn(`Payment ${p.id} captured for ${b.status} booking ${b.id}; auto-refunding`);
        if (b.status === 'cancelled') await this.state.transition(c, BookingMachine, b.id, 'initiate_refund', SYSTEM_ACTOR);
        const s = computeSettlement(fees, money(0, b.currency_code));
        refundToProcess = await this.createRefund(c, { bookingId: b.id, settlement: s, reason: 'Payment received after booking was cancelled', actor: SYSTEM_ACTOR });
      }
    });
    if (refundToProcess) await this.processRefund(refundToProcess).catch(e => this.log.error(`refund ${refundToProcess}: ${e.message}`));
  }

  private async fail(evt: NormalizedGatewayEvent) {
    await this.db.tx(async c => {
      const p = await this.db.one(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [evt.paymentId], c);
      if (!p || !['intent_created', 'authorized'].includes(p.status)) return;
      await this.state.transition(c, PaymentMachine, p.id, 'fail', SYSTEM_ACTOR, {
        set: { failure_code: evt.failureCode ?? 'declined', failure_message: evt.failureMessage ?? null, gateway_reference: evt.gatewayReference ?? null },
      });
      const b = await this.db.one(`SELECT id, reference, customer_id, market_id FROM bookings WHERE id = $1`, [p.booking_id], c);
      const cust = await this.db.one(`UPDATE customers SET payment_decline_count = payment_decline_count + 1 WHERE id = $1 RETURNING payment_decline_count`, [b!.customer_id], c);
      const recent = await this.db.one(
        `SELECT count(*)::int AS n FROM payments p JOIN bookings bk ON bk.id = p.booking_id WHERE bk.customer_id = $1 AND p.status = 'failed' AND p.updated_at > now() - interval '1 hour'`, [b!.customer_id], c);
      if (recent!.n >= 4) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,'card_testing',4,$2,$3)`,
          [b!.customer_id, b!.id, JSON.stringify({ failuresLastHour: recent!.n, lifetimeDeclines: cust!.payment_decline_count })]);
      }
      await this.outbox.emit(c, Events.PaymentFailed, 'booking', b!.id, { bookingId: b!.id, reference: b!.reference, customerId: b!.customer_id, reason: evt.failureCode }, b!.market_id);
    });
  }

  /** Fallback when the webhook is delayed: ask the gateway, then apply the same path. */
  async verify(actor: Actor, paymentId: string) {
    const p = await this.db.oneOrFail(
      `SELECT p.*, b.customer_id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = $1`, [paymentId], undefined, 'Payment');
    if (actor.type === 'customer' && p.customer_id !== actor.userId) throw new ForbiddenError();
    if (p.status === 'intent_created') {
      const evt = await this.gateway(p.gateway).fetchStatus(p.id, p.gateway_reference);
      if (evt) await this.applyEvent(p.gateway, evt);
    }
    const fresh = await this.db.one(`SELECT p.id, p.status, p.failure_code, p.amount_charged_to_customer, p.currency_code, p.booking_id, b.status AS booking_status
                                       FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = $1`, [paymentId]);
    return fresh;
  }

  /* ───────────── refunds (§F.5) ───────────── */

  /**
   * Records a refund for a settlement inside the caller's transaction:
   * refund row + refund_initiated journal (+ clawback when the payout already left).
   * Call processRefund(id) AFTER the transaction commits.
   */
  async createRefund(c: Queryable, a: { bookingId: string; settlement: Settlement; reason: string; actor: Actor; disputeId?: string | null }): Promise<string | null> {
    const s = a.settlement;
    if (s.refundToCustomer.minor <= 0) return null;
    const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1`, [a.bookingId], c, 'Booking');
    const p = await this.db.one(`SELECT * FROM payments WHERE booking_id = $1 AND status IN ('captured','partially_refunded') FOR UPDATE`, [b.id], c);
    if (!p) throw new ConflictError('No captured payment to refund');
    const remaining = m(p.amount_charged_to_customer, p.currency_code).minor - m(p.amount_refunded, p.currency_code).minor;
    if (s.refundToCustomer.minor > remaining) throw new ValidationError('Refund exceeds the amount still refundable');
    const payout = await this.db.one(`SELECT status FROM payout_records WHERE booking_id = $1`, [b.id], c);
    const payoutReleased = !!payout && ['released', 'settled'].includes(payout.status);

    const refundId = await this.insertRefundRow(c, b, p, s.refundToCustomer, s.adjusted?.agreed ?? money(0, b.currency_code), a.reason, a.actor, a.disputeId ?? null, 'settlement');
    await this.ledger.post(c, refundInitiatedJournal(s, payoutReleased), {
      idempotencyKey: `refund_initiated:${refundId}`, actor: a.actor, bookingId: b.id, providerId: b.provider_id, referenceId: refundId, referenceType: 'refund' });
    if (payoutReleased && s.providerReduction.minor > 0) {
      await c.query(`INSERT INTO provider_clawbacks (provider_id, booking_id, refund_id, amount, currency_code) VALUES ($1,$2,$3,$4,$5)`,
        [b.provider_id, b.id, refundId, n(s.providerReduction), b.currency_code]);
    }
    // The refund itself is executed by the platform per policy; who requested it is kept in metadata + audit.
    await this.state.transition(c, PaymentMachine, p.id, 'initiate_refund', SYSTEM_ACTOR, { metadata: { requestedBy: a.actor.type, userId: a.actor.userId } });
    await c.query(`UPDATE payment_holds SET hold_status = $2, released_at = now() WHERE booking_id = $1`,
      [b.id, s.providerNetAfter.minor === 0 ? 'released_refund' : 'partially_released']);
    await this.audit.log(c, a.actor, 'refund.initiate', 'refund', refundId, null, { amount: n(s.refundToCustomer), adjustedAgreed: s.adjusted ? n(s.adjusted.agreed) : '0', payoutReleased }, a.reason);
    return refundId;
  }

  private async insertRefundRow(c: Queryable, b: any, p: any, amount: any, adjustedAgreed: any, reason: string, actor: Actor, disputeId: string | null, kind: string) {
    const count = await this.db.one(`SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1`, [b.id], c);
    const row = await this.db.one(
      `INSERT INTO refunds (booking_id, payment_id, dispute_id, amount, currency_code, adjusted_agreed_amount, reason, idempotency_key, initiated_by, initiated_by_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.id, p.id, disputeId, n(amount), b.currency_code, n(adjustedAgreed), `${kind === 'duplicate' ? '[duplicate] ' : ''}${reason}`,
       `refund:${b.id}:${p.id}:${count!.n + 1}`, actor.userId, actor.type], c);
    return row!.id as string;
  }

  /** Sends the refund to the gateway (idempotent by refund key) and settles state on success. */
  async processRefund(refundId: string): Promise<string> {
    const r = await this.db.oneOrFail(
      `SELECT r.*, p.gateway, p.gateway_reference, p.id AS pay_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1`, [refundId], undefined, 'Refund');
    if (r.status !== 'initiated' || r.rail === 'bank_transfer') return r.status;
    const res = await this.gateway(r.gateway).refund({
      paymentId: r.pay_id, gatewayReference: r.gateway_reference, amount: r.amount, currency: r.currency_code, idempotencyKey: r.idempotency_key, reason: r.reason,
    }).catch((e: any) => ({ status: 'failed' as const, error: e.message }));
    if (res.status === 'succeeded') { await this.completeRefund(refundId, res.refundReference ?? null, SYSTEM_ACTOR); return 'processed'; }
    if (res.status === 'unsupported') {
      // Outside the gateway's refund window / API unavailable → Finance pays by bank transfer from reserve (§F.5).
      await this.db.pool.query(`UPDATE refunds SET rail = 'bank_transfer' WHERE id = $1`, [refundId]);
      this.log.warn(`Refund ${refundId} routed to manual bank transfer: ${res.error}`);
      return 'manual';
    }
    if (res.status === 'failed') this.log.warn(`Refund ${refundId} attempt failed: ${res.error}`);
    return 'initiated';
  }

  /** Finance marks a manual (bank transfer) refund as paid. */
  async markRefundPaidManually(actor: Actor, refundId: string, bankReference: string) {
    await this.completeRefund(refundId, bankReference, actor);
    await this.audit.log(this.db.pool, actor, 'refund.mark_paid_manual', 'refund', refundId, null, { bankReference });
    return this.db.one(`SELECT * FROM refunds WHERE id = $1`, [refundId]);
  }

  async completeRefund(refundId: string, reference: string | null, actor: Actor) {
    await this.db.tx(async c => {
      const r = await this.db.one(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId], c);
      if (!r || r.status !== 'initiated') return;
      await c.query(`UPDATE refunds SET status = 'processed', processed_at = now(), gateway_reference = $2 WHERE id = $1`, [r.id, reference]);
      const amt = m(r.amount, r.currency_code);
      await this.ledger.post(c, refundPaidJournal(amt), { idempotencyKey: `refund_paid:${r.id}`, actor, bookingId: r.booking_id, referenceId: r.id, referenceType: 'refund' });
      const p = await this.db.one(`UPDATE payments SET amount_refunded = amount_refunded + $2 WHERE id = $1 RETURNING *`, [r.payment_id, r.amount], c);
      const fully = m(p!.amount_refunded, p!.currency_code).minor >= m(p!.amount_charged_to_customer, p!.currency_code).minor;
      if (p!.status === 'refund_initiated') {
        await this.state.transition(c, PaymentMachine, p!.id, fully ? 'refund_succeeded' : 'refund_partial_succeeded', SYSTEM_ACTOR);
      }
      if (r.reason.startsWith('[duplicate]')) return this.outbox.emit(c, Events.RefundProcessed, 'booking', r.booking_id, await this.refundPayload(c, r));
      const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [r.booking_id], c);
      if (b!.status === 'refund_pending') {
        const payout = await this.db.one(`SELECT status FROM payout_records WHERE booking_id = $1`, [b!.id], c);
        const payoutAlreadyOut = !!payout && ['released', 'settled', 'clawed_back'].includes(payout.status);
        if (m(r.adjusted_agreed_amount, r.currency_code).minor > 0 && !payoutAlreadyOut) {
          await this.state.transition(c, BookingMachine, b!.id, 'refund_processed_partial', SYSTEM_ACTOR);
        } else {
          await this.state.transition(c, BookingMachine, b!.id, 'refund_processed', SYSTEM_ACTOR);
        }
      }
      await this.outbox.emit(c, Events.RefundProcessed, 'booking', r.booking_id, await this.refundPayload(c, r), b!.market_id);
    });
  }

  private async refundPayload(c: Queryable, r: any) {
    const b = await this.db.one(`SELECT reference, customer_id, provider_id FROM bookings WHERE id = $1`, [r.booking_id], c);
    return { bookingId: r.booking_id, refundId: r.id, reference: b!.reference, customerId: b!.customer_id, providerId: b!.provider_id, amount: r.amount, currency: r.currency_code };
  }

  async retryPendingRefunds(): Promise<number> {
    const rows = await this.db.many(`SELECT id FROM refunds WHERE status = 'initiated' AND rail = 'gateway' AND created_at < now() - interval '2 minutes' LIMIT 50`);
    for (const r of rows) await this.processRefund(r.id).catch(e => this.log.warn(`refund retry ${r.id}: ${e.message}`));
    return rows.length;
  }

  /* ───────────── chargebacks (§F.5) ───────────── */

  /** Card-scheme chargeback: freeze payout immediately, open a dispute, page Finance. */
  async chargeback(gatewayName: string, evt: NormalizedGatewayEvent, actor: Actor = SYSTEM_ACTOR) {
    await this.db.tx(async c => {
      const p = await this.db.one(`SELECT * FROM payments WHERE id = $1 OR gateway_reference = $2 LIMIT 1`, [evt.paymentId, evt.gatewayReference ?? ''], c);
      if (!p) throw new NotFoundError('Payment for chargeback not found');
      const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [p.booking_id], c);
      const existing = await this.db.one(`SELECT id FROM disputes WHERE booking_id = $1 AND source = 'chargeback' AND chargeback_reference = $2`, [b!.id, evt.chargebackReference ?? evt.eventId], c);
      if (existing) return;
      await this.payouts.setDisputeFlag(c, b!.id, true, 'chargeback');
      const amount = m(evt.amount ?? p.amount_charged_to_customer, p.currency_code);
      await this.ledger.post(c, chargebackJournal(amount), { idempotencyKey: `chargeback:${evt.chargebackReference ?? evt.eventId}`, actor, bookingId: b!.id, referenceId: p.id, referenceType: 'payment' });
      const respondBy = evt.chargebackRespondBy ? new Date(evt.chargebackRespondBy) : new Date(Date.now() + 7 * 86400_000);
      const prevStatus = b!.status;
      if (BookingMachine.can(b!.status, 'dispute', 'system')) await this.state.transition(c, BookingMachine, b!.id, 'dispute', SYSTEM_ACTOR, { metadata: { chargeback: true } });
      const d = await this.db.one(
        `INSERT INTO disputes (booking_id, raised_by_role, source, reason_code, description, booking_status_at_open, routed_to, sla_due_at, chargeback_reference, chargeback_respond_by)
         VALUES ($1,'system','chargeback','overcharge',$2,$3,'finance',$4,$5,$4) RETURNING id`,
        [b!.id, `Card chargeback via ${gatewayName}: ${evt.failureMessage ?? 'no reason supplied'}`, prevStatus, respondBy, evt.chargebackReference ?? evt.eventId], c);
      await c.query(`UPDATE customers SET chargeback_count = chargeback_count + 1 WHERE id = $1`, [b!.customer_id]);
      await this.outbox.emit(c, Events.ChargebackReceived, 'booking', b!.id, { bookingId: b!.id, disputeId: d!.id, reference: b!.reference, amount: n(amount), currency: amount.currency, respondBy }, b!.market_id);
    });
  }
}
