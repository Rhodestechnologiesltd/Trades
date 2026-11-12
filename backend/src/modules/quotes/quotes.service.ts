import { Injectable } from '@nestjs/common';
import {
  CounterMachine, CounterRound, DEFAULT_ABUSE_LIMITS, DispatchMachine, QuoteMachine, RequestMachine, assertCanRespond, assertPriceInBand,
  currentProviderOffer, money, validateNewCounter,
} from '@trades/domain';
import { Actor } from '../../common/auth';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { StateService } from '../../common/state.service';
import { BookingsService } from '../bookings/bookings.service';
import { DispatchService } from '../dispatch/dispatch.service';

/**
 * Quotes & counter-offers (§A.4, §A.5, §C.3, §C.4). Every counter round is an
 * immutable row; acceptance of a quote or a counter creates the booking atomically.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly outbox: OutboxService,
    private readonly cfg: PlatformConfigService,
    private readonly limits: RateLimitService,
    private readonly dispatch: DispatchService,
    private readonly bookings: BookingsService,
  ) {}

  private async negotiationConfig(q: Queryable, categoryId: string) {
    const cat = await this.db.one(
      `SELECT c.price_floor, c.price_ceiling, COALESCE(c.max_negotiation_rounds, p.max_negotiation_rounds) AS rounds, c.instant_accept_price
         FROM service_categories c LEFT JOIN service_categories p ON p.id = c.parent_id WHERE c.id = $1`, [categoryId], q);
    return { cat, cfg: { maxRounds: cat?.rounds ?? (await this.cfg.maxNegotiationRounds()), priceFloorMinor: null as number | null, priceCeilingMinor: null as number | null } };
  }

  async submit(a: Actor, d: { requestId: string; amount: string; message?: string; estimatedStartAt?: string; estimatedDurationMin?: number; validForMin?: number }) {
    const abuse = await this.cfg.abuse().catch(() => DEFAULT_ABUSE_LIMITS);
    await this.limits.enforce(`quote:${a.userId}`, abuse.maxQuotesPerProviderPerHour, 3600, 'You are sending quotes too quickly. Please slow down.');
    return this.db.tx(async c => {
      const prov = await this.db.one(`SELECT p.verification_status, u.status FROM providers p JOIN users u ON u.id = p.id WHERE p.id = $1`, [a.userId], c);
      if (prov?.verification_status !== 'verified' || prov.status !== 'active') throw new ForbiddenError('Only verified, active providers can quote');
      const r = await this.db.one(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [d.requestId], c);
      if (!r) throw new NotFoundError('Request not found');
      if (!['dispatched', 'quoted'].includes(r.status)) throw new ConflictError('This request is no longer accepting quotes', 'invalid_state');
      const elig = await this.dispatch.assertEligibleToQuote(c, r.id, a.userId!);
      const amount = m(d.amount, r.currency_code);
      const { cat, cfg } = await this.negotiationConfig(c, r.category_id);
      cfg.priceFloorMinor = cat?.price_floor ? m(cat.price_floor, r.currency_code).minor : null;
      cfg.priceCeilingMinor = cat?.price_ceiling ? m(cat.price_ceiling, r.currency_code).minor : null;
      assertPriceInBand(amount.minor, cfg);
      const policy = await this.cfg.dispatchPolicy(r.request_mode);
      const validSec = Math.min(Math.max((d.validForMin ?? policy.quoteValiditySec / 60) * 60, 10 * 60), 72 * 3600);
      const validUntil = new Date(Math.min(Date.now() + validSec * 1000, r.expires_at ? new Date(r.expires_at).getTime() : Infinity));
      const quote = await this.db.one(
        `INSERT INTO quotes (service_request_id, provider_id, amount, currency_code, message, estimated_start_at, estimated_duration_min, valid_until, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING *`,
        [r.id, a.userId, n(amount), r.currency_code, d.message?.trim().slice(0, 1000) ?? null, d.estimatedStartAt ?? null, d.estimatedDurationMin ?? null, validUntil], c);
      await this.state.created(c, 'quote', quote!.id, 'active', a);
      if (elig.status !== 'quoted') await this.state.transition(c, DispatchMachine, elig.dispatchId, 'quote', a, { set: { responded_at: new Date() } });
      if (r.status === 'dispatched') await this.state.transition(c, RequestMachine, r.id, 'quote_received', a);
      // Rolling response-speed metric (EMA, α = 0.2) feeds ranking (§G.3)
      const respSec = Math.max(1, Math.round((Date.now() - new Date(elig.notifiedAt).getTime()) / 1000));
      await c.query(`UPDATE providers SET quotes_submitted = quotes_submitted + 1,
                       response_speed_avg_sec = CASE WHEN response_speed_avg_sec IS NULL THEN $2 ELSE ROUND(response_speed_avg_sec * 0.8 + $2 * 0.2) END WHERE id = $1`, [a.userId, respSec]);
      // Recurring agreement with a pre-agreed rate: the preferred provider accepting at that rate books it directly (§A.3).
      if (r.recurring_agreement_id) {
        const ag = await this.db.one(`SELECT preferred_provider_id, agreed_rate FROM recurring_agreements WHERE id = $1`, [r.recurring_agreement_id], c);
        if (ag?.preferred_provider_id === a.userId && ag.agreed_rate && m(ag.agreed_rate, r.currency_code).minor === amount.minor) {
          const booking = await this.bookings.createFromQuote(c, { quoteId: quote!.id, agreedMinor: amount.minor, actor: { userId: null, type: 'system' }, trigger: 'accept' });
          return { ...quote, autoAccepted: true, bookingId: booking.id };
        }
      }
      const pu = await this.db.one(`SELECT COALESCE(p.business_name, u.full_name) AS name FROM providers p JOIN users u ON u.id = p.id WHERE p.id = $1`, [a.userId], c);
      await this.outbox.emit(c, Events.QuoteSubmitted, 'service_request', r.id, {
        requestId: r.id, quoteId: quote!.id, customerId: r.customer_id, providerName: pu?.name, amount: n(amount), currency: r.currency_code,
        etaMin: Math.max(5, Math.round(elig.distanceM / 1000 / 25 * 60)),
      }, r.market_id);
      return quote;
    });
  }

  async withdraw(a: Actor, quoteId: string) {
    return this.db.tx(async c => {
      const q = await this.db.oneOrFail(`SELECT * FROM quotes WHERE id = $1 FOR UPDATE`, [quoteId], c, 'Quote');
      if (q.provider_id !== a.userId) throw new ForbiddenError();
      await this.state.transition(c, QuoteMachine, q.id, 'withdraw', a);
      const open = await this.db.many(`SELECT id FROM counter_offers WHERE quote_id = $1 AND status = 'proposed'`, [q.id], c);
      for (const co of open) await this.state.transition(c, CounterMachine, co.id, 'expire', { userId: null, type: 'system' });
      await this.maybeRevertRequest(c, q.service_request_id);
      await this.outbox.emit(c, Events.QuoteWithdrawn, 'service_request', q.service_request_id, { requestId: q.service_request_id, quoteId: q.id });
      return { ok: true };
    });
  }

  /** quoted → dispatched when no live quotes remain (§C.1 "all quotes expire/reject → back to dispatched"). */
  private async maybeRevertRequest(c: Queryable, requestId: string) {
    const live = await this.db.one(`SELECT count(*)::int AS n FROM quotes WHERE service_request_id = $1 AND status IN ('active','countered','submitted')`, [requestId], c);
    const r = await this.db.one(`SELECT status FROM service_requests WHERE id = $1`, [requestId], c);
    if (live!.n === 0 && r?.status === 'quoted') {
      await this.state.transition(c, RequestMachine, requestId, 'all_quotes_lapsed', { userId: null, type: 'system' }, { set: { next_dispatch_check_at: new Date() } });
    }
  }

  private async rounds(c: Queryable, quoteId: string): Promise<Array<CounterRound & { id: string; currency: string }>> {
    const rows = await this.db.many(`SELECT * FROM counter_offers WHERE quote_id = $1 ORDER BY round_number FOR UPDATE`, [quoteId], c);
    return rows.map(r => ({ id: r.id, roundNumber: r.round_number, proposedBy: r.proposed_by, amountMinor: m(r.amount, r.currency_code).minor, status: r.status, currency: r.currency_code }));
  }

  /** Customer opens negotiation on a quote (round 1). */
  async counter(a: Actor, quoteId: string, d: { amount: string; message?: string }) {
    return this.db.tx(async c => {
      const q = await this.db.oneOrFail(`SELECT q.*, r.customer_id, r.category_id, r.market_id FROM quotes q JOIN service_requests r ON r.id = q.service_request_id WHERE q.id = $1 FOR UPDATE OF q`, [quoteId], c, 'Quote');
      if (q.customer_id !== a.userId) throw new ForbiddenError();
      if (q.status !== 'active') throw new ConflictError('This quote cannot be countered right now', 'invalid_state');
      if (new Date(q.valid_until) < new Date()) throw new ConflictError('This quote has expired', 'quote_expired');
      const rounds = await this.rounds(c, q.id);
      const { cat, cfg } = await this.negotiationConfig(c, q.category_id);
      cfg.priceFloorMinor = cat?.price_floor ? m(cat.price_floor, q.currency_code).minor : null;
      cfg.priceCeilingMinor = cat?.price_ceiling ? m(cat.price_ceiling, q.currency_code).minor : null;
      const amount = m(d.amount, q.currency_code);
      const roundNo = validateNewCounter('customer', amount.minor, m(q.amount, q.currency_code).minor, rounds, cfg);
      const co = await this.insertCounter(c, q, 'customer', a.userId!, amount.minor, roundNo, d.message, null);
      await this.state.transition(c, QuoteMachine, q.id, 'counter', a, { set: { round_number: roundNo } });
      await this.emitCounter(c, q, co, 'provider', roundNo >= cfg.maxRounds);
      return co;
    });
  }

  private async insertCounter(c: Queryable, q: any, by: 'customer' | 'provider', userId: string, amountMinor: number, roundNo: number, message: string | undefined, parentId: string | null) {
    const validUntil = new Date(Math.min(Date.now() + 24 * 3600_000, new Date(q.valid_until).getTime() + 2 * 3600_000));
    const co = await this.db.one(
      `INSERT INTO counter_offers (quote_id, proposed_by, proposed_by_user_id, amount, currency_code, message, round_number, parent_counter_offer_id, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [q.id, by, userId, n(money(amountMinor, q.currency_code)), q.currency_code, message?.trim().slice(0, 500) ?? null, roundNo, parentId, validUntil], c);
    await this.state.created(c, 'counter_offer', co!.id, 'proposed', { userId, type: by }, { round: roundNo });
    return co!;
  }

  private async emitCounter(c: Queryable, q: any, co: any, recipientRole: 'customer' | 'provider', final: boolean) {
    const from = recipientRole === 'provider'
      ? await this.db.one(`SELECT split_part(full_name,' ',1) AS name FROM users WHERE id = $1`, [q.customer_id], c)
      : await this.db.one(`SELECT COALESCE(p.business_name, u.full_name) AS name FROM providers p JOIN users u ON u.id = p.id WHERE p.id = $1`, [q.provider_id], c);
    await this.outbox.emit(c, Events.CounterOfferProposed, 'service_request', q.service_request_id, {
      requestId: q.service_request_id, quoteId: q.id, counterOfferId: co.id, recipientId: recipientRole === 'provider' ? q.provider_id : q.customer_id,
      recipientRole, fromName: from?.name, amount: co.amount, currency: co.currency_code, round: co.round_number, final,
    }, q.market_id);
  }

  /** Accept / reject / counter an open round. Only the party that did not propose it may respond. */
  async respond(a: Actor, counterId: string, d: { action: 'accept' | 'reject' | 'counter'; amount?: string; message?: string }) {
    return this.db.tx(async c => {
      const co = await this.db.oneOrFail(`SELECT * FROM counter_offers WHERE id = $1`, [counterId], c, 'Counter-offer');
      const q = await this.db.oneOrFail(
        `SELECT q.*, r.customer_id, r.category_id, r.market_id FROM quotes q JOIN service_requests r ON r.id = q.service_request_id WHERE q.id = $1 FOR UPDATE OF q`, [co.quote_id], c, 'Quote');
      const party: 'customer' | 'provider' = a.userId === q.customer_id ? 'customer' : a.userId === q.provider_id ? 'provider' : (() => { throw new ForbiddenError(); })();
      const rounds = await this.rounds(c, q.id);
      const open = assertCanRespond(party, rounds) as (typeof rounds)[number];
      if (open.id !== co.id) throw new ConflictError('This is not the latest offer', 'stale_offer');
      if (new Date(co.valid_until) < new Date()) throw new ConflictError('This offer has expired', 'offer_expired');
      const { cat, cfg } = await this.negotiationConfig(c, q.category_id);

      if (d.action === 'accept') {
        await this.state.transition(c, CounterMachine, co.id, 'accept', a, { set: { responded_at: new Date() } });
        const booking = await this.bookings.createFromQuote(c, { quoteId: q.id, agreedMinor: open.amountMinor, counterOfferId: co.id, actor: a, trigger: 'counter_accepted' });
        await this.outbox.emit(c, Events.CounterOfferResolved, 'service_request', q.service_request_id, {
          requestId: q.service_request_id, recipientId: open.proposedBy === 'customer' ? q.customer_id : q.provider_id, action: 'accepted', amount: co.amount, currency: co.currency_code });
        return { action: 'accepted', bookingId: booking.id };
      }
      if (d.action === 'reject') {
        await this.state.transition(c, CounterMachine, co.id, 'reject', a, { set: { responded_at: new Date() } });
        // Negotiation ends; the provider's last offer stands as final-offer-only (§A.5).
        await this.state.transition(c, QuoteMachine, q.id, 'counter_rejected', a);
        await this.outbox.emit(c, Events.CounterOfferResolved, 'service_request', q.service_request_id, {
          requestId: q.service_request_id, recipientId: open.proposedBy === 'customer' ? q.customer_id : q.provider_id, action: 'rejected', amount: co.amount, currency: co.currency_code });
        return { action: 'rejected', standingOffer: n(money(currentProviderOffer(m(q.amount, q.currency_code).minor, rounds), q.currency_code)) };
      }
      if (!d.amount) throw new ValidationError('amount is required to counter');
      cfg.priceFloorMinor = cat?.price_floor ? m(cat.price_floor, q.currency_code).minor : null;
      cfg.priceCeilingMinor = cat?.price_ceiling ? m(cat.price_ceiling, q.currency_code).minor : null;
      const amount = m(d.amount, q.currency_code);
      const roundNo = validateNewCounter(party, amount.minor, m(q.amount, q.currency_code).minor, rounds, cfg);
      await this.state.transition(c, CounterMachine, co.id, 'counter', a, { set: { responded_at: new Date() } });
      const next = await this.insertCounter(c, q, party, a.userId!, amount.minor, roundNo, d.message, co.id);
      await c.query(`UPDATE quotes SET round_number = $2 WHERE id = $1`, [q.id, roundNo]);
      await this.emitCounter(c, q, next, party === 'customer' ? 'provider' : 'customer', roundNo >= cfg.maxRounds);
      return { action: 'countered', counterOffer: next };
    });
  }

  /** Customer accepts a quote at the provider's current (last) offer → booking (payment_pending). */
  async accept(a: Actor, quoteId: string) {
    return this.db.tx(async c => {
      const q = await this.db.oneOrFail(`SELECT q.*, r.customer_id FROM quotes q JOIN service_requests r ON r.id = q.service_request_id WHERE q.id = $1 FOR UPDATE OF q`, [quoteId], c, 'Quote');
      if (q.customer_id !== a.userId) throw new ForbiddenError();
      if (new Date(q.valid_until) < new Date()) throw new ConflictError('This quote has expired', 'quote_expired');
      const rounds = await this.rounds(c, q.id);
      const open = rounds.find(r => r.status === 'proposed');
      if (open?.proposedBy === 'provider') {
        // Accepting while the provider's counter is open == accepting that counter.
        await this.state.transition(c, CounterMachine, open.id, 'accept', a, { set: { responded_at: new Date() } });
        const b = await this.bookings.createFromQuote(c, { quoteId: q.id, agreedMinor: open.amountMinor, counterOfferId: open.id, actor: a, trigger: 'counter_accepted' });
        return { bookingId: b.id };
      }
      if (q.status !== 'active') throw new ConflictError('Wait for the provider to answer your counter-offer', 'invalid_state');
      const agreed = currentProviderOffer(m(q.amount, q.currency_code).minor, rounds);
      const b = await this.bookings.createFromQuote(c, { quoteId: q.id, agreedMinor: agreed, actor: a, trigger: 'accept' });
      return { bookingId: b.id };
    });
  }

  /**
   * Urgent instant-accept (§G.4): first opted-in provider to accept gets the job at the
   * category's pre-set price — no negotiation round-trip.
   */
  async instantAccept(a: Actor, requestId: string) {
    return this.db.tx(async c => {
      const r = await this.db.oneOrFail(
        `SELECT r.*, c.instant_accept_price FROM service_requests r JOIN service_categories c ON c.id = r.category_id WHERE r.id = $1 FOR UPDATE OF r`, [requestId], c, 'Request');
      const created = await this.db.one(`SELECT metadata FROM state_events WHERE entity_type = 'service_request' AND entity_id = $1 AND trigger = 'create'`, [r.id], c);
      if (r.request_mode !== 'urgent' || !r.instant_accept_price || !created?.metadata?.instantAccept) throw new ConflictError('Instant accept is not available for this request');
      if (r.status !== 'dispatched' && r.status !== 'quoted') throw new ConflictError('This job has already been taken', 'already_taken');
      const p = await this.db.one(`SELECT instant_accept_enabled, verification_status FROM providers WHERE id = $1`, [a.userId], c);
      if (!p?.instant_accept_enabled || p.verification_status !== 'verified') throw new ForbiddenError('Enable instant accept in your settings first');
      const elig = await this.dispatch.assertEligibleToQuote(c, r.id, a.userId!);
      const quote = await this.db.one(
        `INSERT INTO quotes (service_request_id, provider_id, amount, currency_code, message, valid_until, status, is_instant_accept)
         VALUES ($1,$2,$3,$4,'Instant accept',now() + interval '30 minutes','active',true) RETURNING *`,
        [r.id, a.userId, r.instant_accept_price, r.currency_code], c);
      await this.state.created(c, 'quote', quote!.id, 'active', a, { instant: true });
      await this.state.transition(c, DispatchMachine, elig.dispatchId, 'quote', a, { set: { responded_at: new Date() } });
      await c.query(`UPDATE providers SET quotes_submitted = quotes_submitted + 1 WHERE id = $1`, [a.userId]);
      const b = await this.bookings.createFromQuote(c, { quoteId: quote!.id, agreedMinor: m(r.instant_accept_price, r.currency_code).minor, actor: { userId: null, type: 'system' }, trigger: 'accept', instant: true });
      return { bookingId: b.id };
    });
  }

  async mine(a: Actor, status?: string) {
    return this.db.many(
      `SELECT q.*, r.title, r.request_mode, r.status AS request_status, c.name AS category_name, l.area_label,
              (SELECT row_to_json(co) FROM counter_offers co WHERE co.quote_id = q.id ORDER BY round_number DESC LIMIT 1) AS latest_counter,
              b.id AS booking_id
         FROM quotes q JOIN service_requests r ON r.id = q.service_request_id JOIN service_categories c ON c.id = r.category_id
         JOIN request_locations l ON l.service_request_id = r.id LEFT JOIN bookings b ON b.accepted_quote_id = q.id
        WHERE q.provider_id = $1 AND ($2::text IS NULL OR q.status::text = $2) ORDER BY q.created_at DESC LIMIT 100`, [a.userId, status ?? null]);
  }

  /** Scheduler: expire quotes past valid_until and counter-offers past theirs (§A.4). */
  async expireDue(): Promise<number> {
    const sys: Actor = { userId: null, type: 'system' };
    const counters = await this.db.many(`SELECT id, quote_id FROM counter_offers WHERE status = 'proposed' AND valid_until < now() LIMIT 200`);
    for (const co of counters) {
      await this.db.tx(async c => {
        await this.state.transition(c, CounterMachine, co.id, 'expire', sys);
        const q = await this.db.one(`SELECT status FROM quotes WHERE id = $1 FOR UPDATE`, [co.quote_id], c);
        if (q?.status === 'countered') await this.state.transition(c, QuoteMachine, co.quote_id, 'counter_rejected', sys, { metadata: { reason: 'counter_expired' } });
      }).catch(() => undefined);
    }
    const quotes = await this.db.many(`SELECT id, service_request_id FROM quotes WHERE status IN ('submitted','active','countered') AND valid_until < now() LIMIT 200`);
    for (const q of quotes) {
      await this.db.tx(async c => {
        await this.state.transition(c, QuoteMachine, q.id, 'expire', sys);
        const open = await this.db.many(`SELECT id FROM counter_offers WHERE quote_id = $1 AND status = 'proposed'`, [q.id], c);
        for (const co of open) await this.state.transition(c, CounterMachine, co.id, 'expire', sys);
        await this.maybeRevertRequest(c, q.service_request_id);
      }).catch(() => undefined);
    }
    return counters.length + quotes.length;
  }
}
