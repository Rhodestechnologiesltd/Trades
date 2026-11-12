import { Injectable, Logger } from '@nestjs/common';
import {
  BookingMachine, EXACT_LOCATION_VISIBLE_STATES, LIVE_TRACKING_STATES, QuoteMachine, RequestMachine, autoApproveAt, breakdownFromFrozen,
  cancellationOutcome, computeFees, computeSettlement, disputeDeadline, etaMinutes, haversineM, withinGeofence,
} from '@trades/domain';
import { Actor, SYSTEM_ACTOR, isStaff } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { apiMoney, m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { clampLimit, decodeCursor, toPage } from '../../common/pagination';
import { PlatformConfigService } from '../../common/platform-config.service';
import { StateService } from '../../common/state.service';
import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/payments.service';
import { PayoutsService } from '../payouts/payouts.service';
import { RequestsService } from '../requests/requests.service';

@Injectable()
export class BookingsService {
  private readonly log = new Logger('Bookings');

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cfg: PlatformConfigService,
    private readonly requests: RequestsService,
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly media: MediaService,
  ) {}

  /**
   * accepted quote (or counter) → booking in payment_pending with fees FROZEN (§F.2).
   * Runs inside the caller's transaction, with the request row locked first so two
   * concurrent accepts on the same request cannot both succeed.
   */
  async createFromQuote(c: Queryable, a: { quoteId: string; agreedMinor: number; counterOfferId?: string | null; actor: Actor; trigger: 'accept' | 'counter_accepted'; instant?: boolean }) {
    const q = await this.db.oneOrFail(`SELECT * FROM quotes WHERE id = $1`, [a.quoteId], c, 'Quote');
    const r = await this.db.oneOrFail(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [q.service_request_id], c, 'Request');
    await this.state.transition(c, RequestMachine, r.id, a.instant ? 'instant_assign' : 'accept_quote', a.instant ? SYSTEM_ACTOR : a.actor,
      { set: { next_dispatch_check_at: null } });
    await this.state.transition(c, QuoteMachine, q.id, a.trigger, a.actor, a.agreedMinor !== m(q.amount, q.currency_code).minor ? { metadata: { agreed: a.agreedMinor } } : {});
    await this.requests.closeOpenNegotiations(c, r.id, a.actor, q.id);

    const fees = computeFees({ minor: a.agreedMinor, currency: q.currency_code }, await this.cfg.feesFor(r.category_id, r.market_id, c));
    const timing = await this.cfg.timing();
    const b = await this.db.one(
      `INSERT INTO bookings (service_request_id, accepted_quote_id, accepted_counter_offer_id, customer_id, provider_id, category_id,
                             agreed_amount, currency_code, scheduled_start_at, payment_due_at, market_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(secs => $10), $11) RETURNING *`,
      [r.id, q.id, a.counterOfferId ?? null, r.customer_id, q.provider_id, r.category_id, n(fees.agreed), q.currency_code,
       r.scheduled_for ?? q.estimated_start_at ?? null, timing.paymentWindowSec, r.market_id], c);
    await c.query(`INSERT INTO platform_fees (booking_id, fee_bps, fee_amount, currency_code) VALUES ($1,$2,$3,$4)`, [b!.id, fees.customerFeeBps, n(fees.customerFee), q.currency_code]);
    await c.query(`INSERT INTO platform_commissions (booking_id, commission_bps, commission_amount, currency_code) VALUES ($1,$2,$3,$4)`, [b!.id, fees.providerCommissionBps, n(fees.providerCommission), q.currency_code]);
    await c.query(`UPDATE providers SET quotes_accepted = quotes_accepted + 1 WHERE id = $1`, [q.provider_id]);
    await this.state.created(c, 'booking', b!.id, 'payment_pending', a.actor, { quoteId: q.id, counterOfferId: a.counterOfferId ?? null });

    const losers = await this.db.many(`SELECT DISTINCT provider_id FROM quotes WHERE service_request_id = $1 AND provider_id <> $2`, [r.id, q.provider_id], c);
    const cat = await this.db.one(`SELECT name FROM service_categories WHERE id = $1`, [r.category_id], c);
    await this.outbox.emit(c, Events.QuoteAccepted, 'booking', b!.id, {
      bookingId: b!.id, requestId: r.id, reference: b!.reference, providerId: q.provider_id, customerId: r.customer_id,
      loserProviderIds: losers.map(l => l.provider_id), amount: n(fees.agreed), currency: q.currency_code, categoryName: cat?.name,
    }, r.market_id);
    await this.outbox.emit(c, Events.BookingCreated, 'booking', b!.id, {
      bookingId: b!.id, customerId: r.customer_id, providerId: q.provider_id, charge: n(fees.customerCharge), currency: q.currency_code,
    }, r.market_id);
    // Recurring: remember the provider + rate for future occurrences (§A.3, §G.5)
    if (r.recurring_agreement_id) {
      await c.query(`UPDATE recurring_agreements SET preferred_provider_id = COALESCE(preferred_provider_id, $2), agreed_rate = COALESCE(agreed_rate, $3) WHERE id = $1`,
        [r.recurring_agreement_id, q.provider_id, n(fees.agreed)]);
    }
    return b!;
  }

  /* ───────────── reads ───────────── */

  async get(actor: Actor, id: string) {
    const b = await this.db.one(
      `SELECT b.*, r.title, r.description, r.request_mode, r.photo_keys, c.name AS category_name, c.icon AS category_icon,
              l.lat, l.lng, l.approx_lat, l.approx_lng, l.address_text, l.area_label, a.access_notes,
              cu.full_name AS customer_name, cu.phone_number AS customer_phone, pu.full_name AS provider_name, pu.phone_number AS provider_phone,
              pu.avatar_url AS provider_avatar, p.business_name, p.rating_avg AS provider_rating, p.rating_count AS provider_rating_count,
              p.last_lat, p.last_lng, p.last_location_at,
              f.fee_amount, f.fee_bps, cm.commission_amount, cm.commission_bps
         FROM bookings b JOIN service_requests r ON r.id = b.service_request_id JOIN service_categories c ON c.id = b.category_id
         JOIN request_locations l ON l.service_request_id = r.id LEFT JOIN addresses a ON a.id = r.address_id
         JOIN users cu ON cu.id = b.customer_id JOIN users pu ON pu.id = b.provider_id JOIN providers p ON p.id = b.provider_id
         JOIN platform_fees f ON f.booking_id = b.id JOIN platform_commissions cm ON cm.booking_id = b.id
        WHERE b.id = $1`, [id]);
    if (!b) throw new NotFoundError('Booking not found');
    const isCustomer = b.customer_id === actor.userId;
    const isProvider = b.provider_id === actor.userId;
    if (!isCustomer && !isProvider && !isStaff(actor)) throw new ForbiddenError();

    const fees = breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code, b.fee_bps, b.commission_bps);
    const paid = (EXACT_LOCATION_VISIBLE_STATES as readonly string[]).includes(b.status) || ['approved_by_customer', 'payout_pending', 'payout_released', 'disputed'].includes(b.status);
    if (isProvider && paid) await this.audit.sensitiveRead(this.db.pool, actor, 'exact_address', b.customer_id, b.id, 'assigned_job');
    const timeline = await this.state.history('booking', b.id);
    const jobEvents = await this.db.many(`SELECT event_type, payload, occurred_at, within_geofence FROM job_events WHERE booking_id = $1 ORDER BY occurred_at`, [b.id]);
    const photoKeys: string[] = jobEvents.flatMap(e => e.payload?.photoKeys ?? []);
    const photos = await Promise.all(photoKeys.map(k => this.media.signedGet(k).catch(() => null)));
    const payment = await this.db.one(`SELECT id, status, card_brand, card_last4, captured_at, amount_refunded FROM payments WHERE booking_id = $1 ORDER BY attempt DESC LIMIT 1`, [b.id]);
    const payout = isProvider || isStaff(actor)
      ? await this.db.one(`SELECT status, eligible_at, released_at, net_payout_amount, clawback_recovered, hold_reason FROM payout_records WHERE booking_id = $1`, [b.id])
      : null;
    const dispute = await this.db.one(`SELECT id, status, reason_code, resolution, opened_at FROM disputes WHERE booking_id = $1 ORDER BY opened_at DESC LIMIT 1`, [b.id]);
    const myReview = await this.db.one(`SELECT rating, comment, created_at FROM reviews WHERE booking_id = $1 AND reviewer_user_id = $2`, [b.id, actor.userId]);
    const tracking = isCustomer && (LIVE_TRACKING_STATES as readonly string[]).includes(b.status) && b.last_lat != null
      ? { lat: b.last_lat, lng: b.last_lng, at: b.last_location_at } : null;

    return {
      id: b.id, reference: b.reference, status: b.status, requestId: b.service_request_id,
      title: b.title, description: b.description, mode: b.request_mode,
      category: { id: b.category_id, name: b.category_name, icon: b.category_icon },
      scheduledStartAt: b.scheduled_start_at, paymentDueAt: b.payment_due_at, jobStartedAt: b.job_started_at, jobCompletedAt: b.job_completed_at,
      approvedAt: b.approved_at, autoApproveAt: b.auto_approve_at, disputeDeadlineAt: b.dispute_deadline_at, cancelledAt: b.cancelled_at,
      cancelReason: b.cancel_reason, completionNotes: b.completion_notes,
      location: paid || isCustomer || isStaff(actor)
        ? { lat: b.lat, lng: b.lng, precision: 'exact', addressText: b.address_text, accessNotes: b.access_notes, areaLabel: b.area_label }
        : { lat: b.approx_lat, lng: b.approx_lng, precision: 'approximate', areaLabel: b.area_label },
      customer: { id: b.customer_id, name: isProvider ? String(b.customer_name).split(' ')[0] : b.customer_name, phone: isProvider && paid ? b.customer_phone : undefined },
      provider: { id: b.provider_id, name: b.business_name || b.provider_name, avatarUrl: b.provider_avatar, rating: b.provider_rating, ratingCount: b.provider_rating_count, phone: isCustomer && paid ? b.provider_phone : undefined },
      pricing: isProvider
        ? { agreed: apiMoney(fees.agreed), commission: apiMoney(fees.providerCommission), commissionPct: (fees.providerCommissionBps / 100).toFixed(2), payout: apiMoney(fees.providerNet) }
        : isCustomer
          ? { agreed: apiMoney(fees.agreed), platformFee: apiMoney(fees.customerFee), feePct: (fees.customerFeeBps / 100).toFixed(2), total: apiMoney(fees.customerCharge) }
          : { agreed: apiMoney(fees.agreed), platformFee: apiMoney(fees.customerFee), commission: apiMoney(fees.providerCommission), total: apiMoney(fees.customerCharge), providerNet: apiMoney(fees.providerNet), platformGross: apiMoney(fees.platformGross), feePct: (fees.customerFeeBps / 100).toFixed(2), commissionPct: (fees.providerCommissionBps / 100).toFixed(2) },
      payment, payout, dispute, myReview, tracking, photos: photos.filter(Boolean),
      availableActions: BookingMachine.available(b.status, actor.type).filter(t => !['payment_captured', 'assign', 'schedule_payout', 'release_payout', 'auto_approve', 'payment_window_expired', 'initiate_refund', 'refund_processed', 'refund_processed_partial'].includes(t)),
      timeline, jobEvents,
    };
  }

  async history(actor: Actor, opts: { cursor?: string; limit?: number; status?: string; role?: string }) {
    const lim = clampLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    const col = actor.type === 'provider' ? 'b.provider_id' : 'b.customer_id';
    const statuses = opts.status === 'active'
      ? ['payment_pending', 'payment_authorized', 'assigned', 'in_progress', 'completed_by_provider', 'disputed']
      : opts.status === 'past' ? ['approved_by_customer', 'payout_pending', 'payout_released', 'cancelled', 'refunded', 'refund_pending'] : null;
    const rows = await this.db.many(
      `SELECT b.id, b.reference, b.status, b.agreed_amount, b.currency_code, b.scheduled_start_at, b.created_at, b.job_completed_at,
              r.title, r.request_mode, c.name AS category_name, c.icon AS category_icon, l.area_label,
              CASE WHEN $6 THEN cu.full_name ELSE COALESCE(p.business_name, pu.full_name) END AS counterparty_name,
              (SELECT 1 FROM reviews rv WHERE rv.booking_id = b.id AND rv.reviewer_user_id = $1) IS NOT NULL AS reviewed
         FROM bookings b JOIN service_requests r ON r.id = b.service_request_id JOIN service_categories c ON c.id = b.category_id
         JOIN request_locations l ON l.service_request_id = r.id JOIN users cu ON cu.id = b.customer_id
         JOIN users pu ON pu.id = b.provider_id JOIN providers p ON p.id = b.provider_id
        WHERE ${col} = $1 AND ($2::text[] IS NULL OR b.status::text = ANY($2))
          AND ($3::timestamptz IS NULL OR (b.created_at, b.id) < ($3::timestamptz, $4::uuid))
        ORDER BY b.created_at DESC, b.id DESC LIMIT $5`,
      [actor.userId, statuses, cur?.ts ?? null, cur?.id ?? null, lim + 1, actor.type === 'provider']);
    return toPage(rows, lim);
  }

  /* ───────────── job lifecycle (§C.5, §C.7) ───────────── */

  private async loadForProvider(c: Queryable, actor: Actor, id: string) {
    const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c);
    if (!b) throw new NotFoundError('Booking not found');
    if (b.provider_id !== actor.userId) throw new ForbiddenError();
    return b;
  }

  private async jobLocation(c: Queryable, bookingId: string) {
    return this.db.one(`SELECT l.lat, l.lng FROM bookings b JOIN request_locations l ON l.service_request_id = b.service_request_id WHERE b.id = $1`, [bookingId], c);
  }

  /** Provider progress updates that don't change state: en route / arrived / photo / note. */
  async jobEvent(actor: Actor, id: string, d: { type: 'en_route' | 'arrived' | 'photo_uploaded' | 'note_added'; lat?: number; lng?: number; note?: string; photoKeys?: string[]; etaMin?: number }) {
    return this.db.tx(async c => {
      const b = await this.loadForProvider(c, actor, id);
      if (!['assigned', 'in_progress'].includes(b.status)) throw new ConflictError('Job is not active');
      for (const k of d.photoKeys ?? []) this.media.assertOwnedBy(k, actor.userId!);
      const loc = await this.jobLocation(c, id);
      const inFence = d.lat != null && d.lng != null ? withinGeofence({ lat: d.lat, lng: d.lng }, loc!) : null;
      await c.query(`INSERT INTO job_events (booking_id, event_type, actor_user_id, lat, lng, within_geofence, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, d.type, actor.userId, d.lat ?? null, d.lng ?? null, inFence, JSON.stringify({ note: d.note, photoKeys: d.photoKeys ?? [], etaMin: d.etaMin })]);
      if (d.type === 'en_route') {
        const pu = await this.db.one(`SELECT full_name FROM users WHERE id = $1`, [actor.userId], c);
        await this.outbox.emit(c, Events.JobEnRoute, 'booking', id, { bookingId: id, customerId: b.customer_id, providerName: pu?.full_name, etaMin: d.etaMin, reference: b.reference }, b.market_id);
      }
      return { ok: true, withinGeofence: inFence };
    });
  }

  /** assigned → in_progress. Geofence check (§C.5 guard) — outside the fence is allowed but flagged. */
  async start(actor: Actor, id: string, d: { lat?: number; lng?: number; accuracyM?: number }) {
    return this.db.tx(async c => {
      const b = await this.loadForProvider(c, actor, id);
      const loc = await this.jobLocation(c, id);
      const inFence = d.lat != null && d.lng != null ? withinGeofence({ lat: d.lat, lng: d.lng, accuracyM: d.accuracyM }, loc!) : null;
      await this.state.transition(c, BookingMachine, id, 'start', actor, { set: { job_started_at: new Date() }, metadata: { withinGeofence: inFence } });
      await c.query(`INSERT INTO job_events (booking_id, event_type, actor_user_id, lat, lng, within_geofence) VALUES ($1,'started',$2,$3,$4,$5)`,
        [id, actor.userId, d.lat ?? null, d.lng ?? null, inFence]);
      if (inFence === false) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,'start_outside_geofence',2,$2,$3)`,
          [actor.userId, id, JSON.stringify({ lat: d.lat, lng: d.lng })]);
      }
      const pu = await this.db.one(`SELECT full_name FROM users WHERE id = $1`, [actor.userId], c);
      await this.outbox.emit(c, Events.JobStarted, 'booking', id, { bookingId: id, reference: b.reference, customerId: b.customer_id, providerName: pu?.full_name }, b.market_id);
      return { status: 'in_progress', withinGeofence: inFence };
    });
  }

  /** in_progress → completed_by_provider; starts the auto-approve and dispute windows. */
  async complete(actor: Actor, id: string, d: { notes?: string; photoKeys?: string[]; lat?: number; lng?: number }) {
    return this.db.tx(async c => {
      const b = await this.loadForProvider(c, actor, id);
      for (const k of d.photoKeys ?? []) this.media.assertOwnedBy(k, actor.userId!);
      const timing = await this.cfg.timing();
      const now = new Date();
      const loc = await this.jobLocation(c, id);
      const inFence = d.lat != null && d.lng != null ? withinGeofence({ lat: d.lat, lng: d.lng }, loc!, 500) : null;
      await this.state.transition(c, BookingMachine, id, 'complete', actor, {
        set: { job_completed_at: now, completion_notes: d.notes ?? null, auto_approve_at: autoApproveAt(now, timing), dispute_deadline_at: disputeDeadline(now, timing) },
        metadata: { withinGeofence: inFence, photos: d.photoKeys?.length ?? 0 },
      });
      await c.query(`INSERT INTO job_events (booking_id, event_type, actor_user_id, lat, lng, within_geofence, payload) VALUES ($1,'completed',$2,$3,$4,$5,$6)`,
        [id, actor.userId, d.lat ?? null, d.lng ?? null, inFence, JSON.stringify({ notes: d.notes, photoKeys: d.photoKeys ?? [] })]);
      // Fake-completion heuristic (§J): completed far from site or implausibly fast.
      const started = b.job_started_at ? new Date(b.job_started_at).getTime() : now.getTime();
      if (inFence === false || now.getTime() - started < 3 * 60_000) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,'fake_completion',3,$2,$3)`,
          [actor.userId, id, JSON.stringify({ withinGeofence: inFence, durationSec: Math.round((now.getTime() - started) / 1000) })]);
      }
      await c.query(`UPDATE providers SET current_active_jobs = GREATEST(current_active_jobs - 1, 0) WHERE id = $1`, [b.provider_id]);
      const r = await this.db.one(`SELECT request_mode FROM service_requests WHERE id = $1`, [b.service_request_id], c);
      if (r?.request_mode === 'urgent') await c.query(`UPDATE providers SET urgent_jobs_completed = urgent_jobs_completed + 1 WHERE id = $1`, [b.provider_id]);
      const pu = await this.db.one(`SELECT full_name FROM users WHERE id = $1`, [actor.userId], c);
      await this.outbox.emit(c, Events.JobCompleted, 'booking', id, { bookingId: id, reference: b.reference, customerId: b.customer_id, providerName: pu?.full_name, autoApproveAt: autoApproveAt(now, timing) }, b.market_id);
      return { status: 'completed_by_provider', autoApproveAt: autoApproveAt(now, timing) };
    });
  }

  /** completed_by_provider → approved_by_customer → payout_pending (T+48h). */
  async approve(actor: Actor, id: string, auto = false) {
    return this.db.tx(async c => {
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c, 'Booking');
      if (!auto && b.customer_id !== actor.userId) throw new ForbiddenError();
      const now = new Date();
      await this.state.transition(c, BookingMachine, id, auto ? 'auto_approve' : 'approve', auto ? SYSTEM_ACTOR : actor, { set: { approved_at: now } });
      const { eligibleAt, net } = await this.payouts.schedule(c, id, now);
      await this.outbox.emit(c, Events.JobApproved, 'booking', id, { bookingId: id, reference: b.reference, providerId: b.provider_id, customerId: b.customer_id, net: n(net), currency: b.currency_code, eligibleAt, auto }, b.market_id);
      // Collusion heuristic (§J): same pair, many fast approvals in a short period
      const pair = await this.db.one(
        `SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1 AND provider_id = $2 AND approved_at > now() - interval '7 days'
            AND approved_at - job_completed_at < interval '5 minutes'`, [b.customer_id, b.provider_id], c);
      if (pair!.n >= 4) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,'collusion',3,$2,$3)`,
          [b.provider_id, id, JSON.stringify({ customerId: b.customer_id, fastApprovals7d: pair!.n })]);
      }
      return { status: 'payout_pending', payoutEligibleAt: eligibleAt };
    });
  }

  /**
   * Cancellation (§C.5): refund policy depends on state and who cancels
   * (packages/domain cancellationOutcome). Provider cancellations/no-shows are
   * penalised and the customer's job is re-dispatched (fast re-matching, §K risks).
   */
  async cancel(actor: Actor, id: string, reason: string, opts: { noShow?: boolean } = {}) {
    let refundId: string | null = null;
    let redispatchFrom: string | null = null;
    const result = await this.db.tx(async c => {
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c, 'Booking');
      if (actor.type === 'customer' && b.customer_id !== actor.userId) throw new ForbiddenError();
      if (actor.type === 'provider' && b.provider_id !== actor.userId) throw new ForbiddenError();
      const agreed = m(b.agreed_amount, b.currency_code);
      const outcome = cancellationOutcome({
        bookingState: b.status, actor: actor.type as any, agreed, scheduledStart: b.scheduled_start_at ? new Date(b.scheduled_start_at) : null, now: new Date(), isNoShow: opts.noShow,
      }, await this.cfg.cancellation());
      const wasAssigned = ['assigned', 'in_progress'].includes(b.status);
      await this.state.transition(c, BookingMachine, id, opts.noShow ? 'no_show' : 'cancel', actor, {
        set: { cancelled_at: new Date(), cancelled_by: actor.type, cancel_reason: `${reason}${outcome.reason ? ` (${outcome.reason})` : ''}` },
      });
      if (wasAssigned) await c.query(`UPDATE providers SET current_active_jobs = GREATEST(current_active_jobs - 1, 0) WHERE id = $1`, [b.provider_id]);
      if (outcome.providerPenalty) {
        const p = await this.db.one(`UPDATE providers SET no_show_count = no_show_count + 1 WHERE id = $1 RETURNING no_show_count`, [b.provider_id], c);
        await c.query(`INSERT INTO job_events (booking_id, event_type, actor_user_id, payload) VALUES ($1,'no_show_reported',$2,$3)`, [id, actor.userId, JSON.stringify({ reason })]);
        const limits = await this.cfg.abuse();
        if (p!.no_show_count >= limits.noShowSuspensionThreshold) {
          await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,'no_show',4,$2,$3)`,
            [b.provider_id, id, JSON.stringify({ noShowCount: p!.no_show_count, threshold: limits.noShowSuspensionThreshold })]);
        }
        redispatchFrom = b.service_request_id;
      }
      const captured = await this.db.one(`SELECT id FROM payments WHERE booking_id = $1 AND status IN ('captured','partially_refunded')`, [id], c);
      let refundAmount: string | null = null;
      if (captured) {
        const fb = breakdownFromFrozen(agreed.minor, b.currency_code,
          (await this.db.one(`SELECT fee_bps FROM platform_fees WHERE booking_id = $1`, [id], c))!.fee_bps,
          (await this.db.one(`SELECT commission_bps FROM platform_commissions WHERE booking_id = $1`, [id], c))!.commission_bps);
        const s = computeSettlement(fb, outcome.adjustedAgreed);
        await this.state.transition(c, BookingMachine, id, 'initiate_refund', SYSTEM_ACTOR);
        refundId = await this.payments.createRefund(c, { bookingId: id, settlement: s, reason: outcome.reason, actor });
        if (s.providerNetAfter.minor > 0) await this.payouts.applySettlement(c, id, s, { eligibleNow: false });
        refundAmount = n(s.refundToCustomer);
        if (!refundId) await this.state.transition(c, BookingMachine, id, 'refund_processed_partial', SYSTEM_ACTOR);
      }
      await this.audit.log(c, actor, opts.noShow ? 'booking.no_show' : 'booking.cancel', 'booking', id, { status: b.status }, { outcome }, reason);
      await this.outbox.emit(c, Events.BookingCancelled, 'booking', id, {
        bookingId: id, reference: b.reference, customerId: b.customer_id, providerId: b.provider_id, cancelledBy: actor.type, reason,
        refund: refundAmount ? `${b.currency_code} ${refundAmount}` : null, noShow: !!opts.noShow,
      }, b.market_id);
      return { status: refundId ? 'refund_pending' : 'cancelled', outcome: outcome.reason, refund: refundAmount };
    });
    if (refundId) await this.payments.processRefund(refundId).catch(e => this.log.warn(`refund ${refundId}: ${e.message}`));
    if (redispatchFrom) await this.redispatch(redispatchFrom).catch(e => this.log.warn(`redispatch ${redispatchFrom}: ${e.message}`));
    return result;
  }

  /** After a provider no-show / cancellation, clone the request and match again — the customer still needs the job done. */
  private async redispatch(requestId: string) {
    const r = await this.db.one(`SELECT r.*, l.lat, l.lng, l.source, l.address_text, l.area_label, l.precision_level FROM service_requests r JOIN request_locations l ON l.service_request_id = r.id WHERE r.id = $1`, [requestId]);
    if (!r) return;
    const scheduled = r.scheduled_for && new Date(r.scheduled_for).getTime() > Date.now() + 45 * 60_000;
    // System-initiated on the customer's behalf: does not count toward their urgent-request quota.
    await this.requests.create({ userId: r.customer_id, type: 'system' }, {
      categoryId: r.category_id, mode: scheduled ? r.request_mode : 'urgent', title: r.title, description: `${r.description}\n\n(Re-booked after the previous provider could not attend.)`,
      scheduledFor: scheduled ? r.scheduled_for.toISOString() : undefined, addressId: r.address_id ?? undefined,
      location: r.address_id ? undefined : { lat: r.lat, lng: r.lng, source: r.source === 'gps' ? 'gps' : 'manual', addressText: r.address_text, areaLabel: r.area_label },
      precisionLevel: r.precision_level, photoKeys: r.photo_keys,
    });
  }

  /* ───────────── scheduler sweeps ───────────── */

  async expireUnpaid(): Promise<number> {
    const rows = await this.db.many(`SELECT id FROM bookings WHERE status = 'payment_pending' AND payment_due_at < now() LIMIT 100`);
    for (const r of rows) {
      await this.db.tx(async c => {
        const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [r.id], c);
        if (b?.status !== 'payment_pending') return;
        await this.state.transition(c, BookingMachine, r.id, 'payment_window_expired', SYSTEM_ACTOR, { set: { cancelled_at: new Date(), cancelled_by: 'system', cancel_reason: 'Payment not completed in time' } });
        await c.query(`UPDATE payments SET status = 'failed', failure_code = 'expired' WHERE booking_id = $1 AND status = 'intent_created'`, [r.id]);
        await this.outbox.emit(c, Events.BookingCancelled, 'booking', r.id, { bookingId: r.id, reference: b.reference, customerId: b.customer_id, providerId: b.provider_id, cancelledBy: 'system', reason: 'payment was not completed in time' }, b.market_id);
      }).catch(e => this.log.warn(`expireUnpaid ${r.id}: ${e.message}`));
    }
    return rows.length;
  }

  async autoApproveDue(): Promise<number> {
    const timing = await this.cfg.timing();
    const remind = await this.db.many(
      `SELECT id, reference, customer_id, market_id, auto_approve_at FROM bookings WHERE status = 'completed_by_provider' AND auto_approve_reminded_at IS NULL
          AND auto_approve_at - make_interval(secs => $1) <= now() LIMIT 200`, [timing.autoApproveReminderBeforeSec]);
    for (const b of remind) {
      await this.db.tx(async c => {
        await c.query(`UPDATE bookings SET auto_approve_reminded_at = now() WHERE id = $1`, [b.id]);
        const hoursLeft = Math.max(1, Math.round((new Date(b.auto_approve_at).getTime() - Date.now()) / 3600_000));
        await this.outbox.emit(c, Events.AutoApproveReminder, 'booking', b.id, { bookingId: b.id, reference: b.reference, customerId: b.customer_id, hoursLeft }, b.market_id);
      });
    }
    const due = await this.db.many(`SELECT id FROM bookings WHERE status = 'completed_by_provider' AND auto_approve_at <= now() LIMIT 100`);
    for (const b of due) await this.approve(SYSTEM_ACTOR, b.id, true).catch(e => this.log.warn(`autoApprove ${b.id}: ${e.message}`));
    return remind.length + due.length;
  }

  /** Provider never started: past scheduled start (+grace) with no arrival/start → no-show (§K). */
  async detectNoShows(): Promise<number> {
    const timing = await this.cfg.timing();
    const rows = await this.db.many(
      `SELECT b.id FROM bookings b
        WHERE b.status = 'assigned' AND COALESCE(b.scheduled_start_at, b.updated_at + interval '90 minutes') + make_interval(secs => $1) < now()
          AND NOT EXISTS (SELECT 1 FROM job_events je WHERE je.booking_id = b.id AND je.event_type IN ('arrived','started'))
        LIMIT 50`, [timing.noShowGraceSec]);
    for (const r of rows) await this.cancel(SYSTEM_ACTOR, r.id, 'Provider did not arrive', { noShow: true }).catch(e => this.log.warn(`noShow ${r.id}: ${e.message}`));
    return rows.length;
  }

  /** Live tracking for the customer (§G.7): only while assigned / in progress. */
  async tracking(actor: Actor, id: string) {
    const b = await this.db.oneOrFail(
      `SELECT b.customer_id, b.provider_id, b.status, p.last_lat, p.last_lng, p.last_location_at, l.lat AS job_lat, l.lng AS job_lng
         FROM bookings b JOIN providers p ON p.id = b.provider_id JOIN request_locations l ON l.service_request_id = b.service_request_id WHERE b.id = $1`, [id], undefined, 'Booking');
    if (b.customer_id !== actor.userId && !isStaff(actor)) throw new ForbiddenError();
    if (!(LIVE_TRACKING_STATES as readonly string[]).includes(b.status) || b.last_lat == null) return { available: false };
    await this.audit.sensitiveRead(this.db.pool, actor, 'provider_location', b.provider_id, id, 'live_tracking');
    const d = haversineM(b.last_lat, b.last_lng, b.job_lat, b.job_lng);
    return { available: true, lat: b.last_lat, lng: b.last_lng, at: b.last_location_at, distanceM: Math.round(d), etaMin: etaMinutes(d) };
  }
}
