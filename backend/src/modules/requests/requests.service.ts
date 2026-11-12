import { Injectable } from '@nestjs/common';
import {
  approximateLocation, CounterMachine, DEFAULT_ABUSE_LIMITS, DispatchMachine, QuoteMachine, EXACT_LOCATION_VISIBLE_STATES, isValidCoordinate, moderateText, RequestMachine, etaMinutes,
} from '@trades/domain';
import { Actor, isStaff } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService, Queryable } from '../../common/db.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { Events, OutboxService } from '../../common/outbox.service';
import { clampLimit, decodeCursor, toPage } from '../../common/pagination';
import { PlatformConfigService } from '../../common/platform-config.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { StateService } from '../../common/state.service';
import { MediaService } from '../media/media.service';

export interface CreateRequestInput {
  categoryId: string;
  mode: 'scheduled' | 'urgent' | 'recurring';
  title?: string;
  description: string;
  photoKeys?: string[];
  scheduledFor?: string;
  scheduledWindowMin?: number;
  urgencyLevel?: 'normal' | 'high' | 'critical';
  budgetHint?: string;
  addressId?: string;
  location?: { lat: number; lng: number; source: 'gps' | 'manual'; addressText?: string; areaLabel?: string };
  precisionLevel?: 'exact' | 'approximate';
  instantAccept?: boolean;
  recurringAgreementId?: string;
  occurrenceAt?: string;
  /** internal: caller handles dispatch itself (recurring preferred-provider offer) */
  skipDispatch?: boolean;
}

/** How far ahead of a scheduled job we dispatch (§A.3 "on creation or closer to the date"). */
const SCHEDULED_DISPATCH_LEAD_HOURS = 72;

@Injectable()
export class RequestsService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cfg: PlatformConfigService,
    private readonly limits: RateLimitService,
    private readonly media: MediaService,
  ) {}

  async create(actor: Actor, d: CreateRequestInput, q?: Queryable) {
    if (!d.description?.trim()) throw new ValidationError('Describe what you need');
    const run = async (c: Queryable) => {
      const cat = await this.db.one(`SELECT * FROM service_categories WHERE id = $1 AND is_active`, [d.categoryId], c);
      if (!cat) throw new ValidationError('Unknown service category');
      if (d.mode === 'urgent' && !cat.urgency_allowed) throw new ValidationError(`${cat.name} cannot be booked as urgent`);
      const user = await this.db.oneOrFail(`SELECT u.market_id, m.currency_code, m.timezone FROM users u JOIN markets m ON m.id = u.market_id WHERE u.id = $1`, [actor.userId], c, 'Customer');

      if (d.mode === 'urgent' && actor.type === 'customer') {
        const abuse = await this.cfg.abuse().catch(() => DEFAULT_ABUSE_LIMITS);
        await this.limits.enforce(`urgent:${actor.userId}`, abuse.maxUrgentRequestsPerCustomerPerDay, 86400,
          'You have reached the daily limit for urgent requests. Please book a scheduled visit or contact support.');
      }
      let scheduledFor: Date | null = null;
      if (d.mode !== 'urgent') {
        if (!d.scheduledFor) throw new ValidationError('Choose a date and time');
        scheduledFor = new Date(d.scheduledFor);
        if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() + 30 * 60_000) throw new ValidationError('Scheduled time must be at least 30 minutes from now');
        if (scheduledFor.getTime() > Date.now() + 180 * 86400_000) throw new ValidationError('Scheduled time must be within 6 months');
      }
      for (const k of d.photoKeys ?? []) this.media.assertOwnedBy(k, actor.userId!);

      // Resolve location: saved address or GPS/manual pin
      let lat: number, lng: number, source: 'gps' | 'manual' | 'saved_address', addressText: string | null, area: string | null;
      let precision = d.precisionLevel ?? 'approximate';
      if (d.addressId) {
        const a = await this.db.one(`SELECT * FROM addresses WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`, [d.addressId, actor.userId], c);
        if (!a) throw new ValidationError('Address not found');
        ({ lat, lng } = a); source = 'saved_address';
        addressText = [a.line1, a.line2, a.city].filter(Boolean).join(', ');
        area = a.city; precision = d.precisionLevel ?? a.precision_level;
      } else if (d.location) {
        if (!isValidCoordinate(d.location.lat, d.location.lng)) throw new ValidationError('Invalid location');
        ({ lat, lng } = d.location); source = d.location.source;
        addressText = d.location.addressText ?? null; area = d.location.areaLabel ?? null;
      } else throw new ValidationError('A location is required');

      const policy = await this.cfg.dispatchPolicy(d.mode);
      const description = moderateText(d.description.trim());
      const dispatchAt = scheduledFor && scheduledFor.getTime() - Date.now() > SCHEDULED_DISPATCH_LEAD_HOURS * 3600_000
        ? new Date(scheduledFor.getTime() - SCHEDULED_DISPATCH_LEAD_HOURS * 3600_000)
        : new Date();
      const expiresAt = d.mode === 'urgent' ? new Date(Date.now() + 2 * 3600_000) : scheduledFor;

      const req = await this.db.one(
        `INSERT INTO service_requests (customer_id, category_id, request_mode, status, title, description, photo_keys, scheduled_for,
            scheduled_window_min, urgency_level, budget_hint, currency_code, recurring_agreement_id, occurrence_at, address_id, market_id,
            current_search_radius_m, next_dispatch_check_at, expires_at)
         VALUES ($1,$2,$3,'requested',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [actor.userId, d.categoryId, d.mode, (d.title ?? cat.name).slice(0, 120), description.text, d.photoKeys ?? [], scheduledFor,
         d.scheduledWindowMin ?? null, d.mode === 'urgent' ? d.urgencyLevel ?? 'high' : 'normal', d.budgetHint ?? null,
         user.currency_code, d.recurringAgreementId ?? null, d.occurrenceAt ?? null, d.addressId ?? null, user.market_id,
         policy.initialRadiusM, d.skipDispatch ? null : dispatchAt, expiresAt], c);
      const approx = approximateLocation(lat, lng);
      await c.query(
        `INSERT INTO request_locations (service_request_id, lat, lng, approx_lat, approx_lng, precision_level, source, address_text, area_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [req!.id, lat, lng, approx.lat, approx.lng, precision, source, addressText, area]);
      await this.state.created(c, 'service_request', req!.id, 'requested', actor, { mode: d.mode, instantAccept: !!d.instantAccept });
      await this.outbox.emit(c, Events.RequestCreated, 'service_request', req!.id,
        { requestId: req!.id, customerId: actor.userId, mode: d.mode, categoryName: cat.name, instantAccept: !!d.instantAccept && !!cat.instant_accept_price,
          dispatchNow: !d.skipDispatch && dispatchAt.getTime() <= Date.now() + 1000 }, user.market_id);
      return req!;
    };
    const created = q ? await run(q) : await this.db.tx(run);
    return q ? created : this.get({ ...actor }, created.id);
  }

  /** Request view, shaped per viewer and privacy rules (§G.7). */
  async get(actor: Actor, id: string) {
    const r = await this.db.one(
      `SELECT r.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon, c.instant_accept_price,
              l.lat, l.lng, l.approx_lat, l.approx_lng, l.precision_level, l.area_label, l.address_text,
              b.id AS booking_id, b.status AS booking_status, b.provider_id AS booking_provider_id,
              split_part(cu.full_name, ' ', 1) AS customer_first_name, cust.rating_avg AS customer_rating, cust.rating_count AS customer_rating_count
         FROM service_requests r JOIN service_categories c ON c.id = r.category_id
         JOIN request_locations l ON l.service_request_id = r.id
         JOIN users cu ON cu.id = r.customer_id JOIN customers cust ON cust.id = r.customer_id
         LEFT JOIN bookings b ON b.service_request_id = r.id
        WHERE r.id = $1`, [id]);
    if (!r) throw new NotFoundError('Request not found');

    const isOwner = r.customer_id === actor.userId;
    let dispatch: any = null;
    if (actor.type === 'provider') {
      dispatch = await this.db.one(`SELECT * FROM provider_dispatches WHERE service_request_id = $1 AND provider_id = $2`, [id, actor.userId]);
      const hasQuote = await this.db.one(`SELECT 1 FROM quotes WHERE service_request_id = $1 AND provider_id = $2`, [id, actor.userId]);
      if (!dispatch && !hasQuote && !(await this.providerCanSee(actor.userId!, id))) throw new ForbiddenError('This request was not sent to you');
      if (dispatch?.status === 'notified') {
        await this.db.tx(c => this.state.transition(c, DispatchMachine, dispatch.id, 'view', actor,
          { set: { viewed_at: new Date() } })).catch(() => undefined);
      }
    } else if (!isOwner && !isStaff(actor)) {
      throw new ForbiddenError();
    }

    const exactVisible = isOwner || isStaff(actor) ||
      (actor.type === 'provider' && r.booking_provider_id === actor.userId && (EXACT_LOCATION_VISIBLE_STATES as readonly string[]).includes(r.booking_status));
    if (exactVisible && actor.type === 'provider') {
      await this.audit.sensitiveRead(this.db.pool, actor, 'exact_address', r.customer_id, r.id, 'assigned_job');
    }
    const photos = await Promise.all((r.photo_keys ?? []).map((k: string) => this.media.signedGet(k).catch(() => null)));
    const base = {
      id: r.id, status: r.status, mode: r.request_mode, title: r.title, description: r.description, photos: photos.filter(Boolean),
      category: { id: r.category_id, name: r.category_name, slug: r.category_slug, icon: r.category_icon },
      scheduledFor: r.scheduled_for, scheduledWindowMin: r.scheduled_window_min, urgencyLevel: r.urgency_level,
      budgetHint: r.budget_hint, currency: r.currency_code, createdAt: r.created_at, expiresAt: r.expires_at,
      instantAcceptPrice: r.instant_accept_price,
      bookingId: r.booking_id, bookingStatus: r.booking_status,
      location: exactVisible
        ? { lat: r.lat, lng: r.lng, precision: 'exact', areaLabel: r.area_label, addressText: r.address_text }
        : { lat: r.approx_lat, lng: r.approx_lng, precision: 'approximate', areaLabel: r.area_label },
      customer: { firstName: r.customer_first_name, rating: r.customer_rating, ratingCount: r.customer_rating_count },
    };

    if (actor.type === 'provider') {
      const myQuote = await this.db.one(`SELECT * FROM quotes WHERE service_request_id = $1 AND provider_id = $2 ORDER BY created_at DESC LIMIT 1`, [id, actor.userId]);
      const rounds = myQuote ? await this.db.many(`SELECT * FROM counter_offers WHERE quote_id = $1 ORDER BY round_number`, [myQuote.id]) : [];
      const distance = await this.db.one(
        `SELECT ST_Distance(COALESCE(p.last_geog, p.home_base_geog), l.geog)::int AS m FROM providers p, request_locations l
          WHERE p.id = $1 AND l.service_request_id = $2`, [actor.userId, id]);
      return {
        ...base, dispatch: dispatch ? { status: dispatch.status, responseDeadline: dispatch.response_deadline } : null,
        distanceM: distance?.m ?? null, etaMin: distance?.m ? etaMinutes(distance.m) : null,
        myQuote: myQuote ? { ...myQuote, counterOffers: rounds } : null,
      };
    }
    // Customer / staff: quotes ranked by price, rating, ETA (§A.4)
    const quotes = await this.db.many(
      `SELECT q.*, u.full_name AS provider_name, u.avatar_url AS provider_avatar, p.business_name, p.rating_avg, p.rating_count,
              p.verification_status, pd.distance_m,
              (SELECT count(*)::int FROM bookings b WHERE b.provider_id = p.id AND b.status IN ('payout_pending','payout_released')) AS jobs_completed
         FROM quotes q JOIN providers p ON p.id = q.provider_id JOIN users u ON u.id = p.id
         LEFT JOIN provider_dispatches pd ON pd.service_request_id = q.service_request_id AND pd.provider_id = q.provider_id
        WHERE q.service_request_id = $1 AND q.status IN ('active','countered','accepted')
        ORDER BY q.amount ASC, p.rating_avg DESC NULLS LAST`, [id]);
    const rounds = quotes.length
      ? await this.db.many(`SELECT * FROM counter_offers WHERE quote_id = ANY($1) ORDER BY quote_id, round_number`, [quotes.map(q => q.id)])
      : [];
    const dispatchStats = await this.db.one(
      `SELECT count(*)::int AS notified, count(*) FILTER (WHERE status = 'viewed')::int AS viewed, count(*) FILTER (WHERE status = 'declined')::int AS declined
         FROM provider_dispatches WHERE service_request_id = $1 AND status <> 'candidate_identified'`, [id]);
    return {
      ...base, dispatchStats, searchRadiusM: r.current_search_radius_m,
      quotes: quotes.map(q => ({
        id: q.id, amount: q.amount, currency: q.currency_code, message: q.message, status: q.status, validUntil: q.valid_until,
        estimatedStartAt: q.estimated_start_at, estimatedDurationMin: q.estimated_duration_min, isInstantAccept: q.is_instant_accept,
        etaMin: q.distance_m ? etaMinutes(q.distance_m) : null, distanceM: q.distance_m,
        provider: { id: q.provider_id, name: q.business_name || q.provider_name, avatarUrl: q.provider_avatar, rating: q.rating_avg, ratingCount: q.rating_count, verified: q.verification_status === 'verified', jobsCompleted: q.jobs_completed },
        counterOffers: rounds.filter(c => c.quote_id === q.id),
      })),
    };
  }

  /** Providers browsing open jobs may view requests in their categories/zones that they were not (yet) notified about. */
  private async providerCanSee(providerId: string, requestId: string): Promise<boolean> {
    const r = await this.db.one(`SELECT status FROM service_requests WHERE id = $1`, [requestId]);
    if (!r || !['dispatched', 'quoted'].includes(r.status)) return false;
    const row = await this.db.one(`SELECT 1 FROM find_dispatch_candidates($1, 100000, false, 1000) WHERE provider_id = $2`, [requestId, providerId]);
    return !!row;
  }

  async listMine(actor: Actor, opts: { cursor?: string; limit?: number; status?: string }) {
    const lim = clampLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    const rows = await this.db.many(
      `SELECT r.id, r.status, r.request_mode, r.title, r.scheduled_for, r.created_at, r.currency_code, c.name AS category_name, c.icon AS category_icon,
              (SELECT count(*)::int FROM quotes q WHERE q.service_request_id = r.id AND q.status IN ('active','countered')) AS live_quotes,
              (SELECT min(q.amount) FROM quotes q WHERE q.service_request_id = r.id AND q.status IN ('active','countered')) AS best_quote,
              b.id AS booking_id, b.status AS booking_status
         FROM service_requests r JOIN service_categories c ON c.id = r.category_id LEFT JOIN bookings b ON b.service_request_id = r.id
        WHERE r.customer_id = $1 AND ($2::text IS NULL OR r.status::text = $2)
          AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $5`, [actor.userId, opts.status ?? null, cur?.ts ?? null, cur?.id ?? null, lim + 1]);
    return toPage(rows, lim);
  }

  async cancel(actor: Actor, id: string, reason?: string) {
    await this.db.tx(async c => {
      const r = await this.db.oneOrFail(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [id], c, 'Request');
      if (actor.type === 'customer' && r.customer_id !== actor.userId) throw new ForbiddenError();
      await this.state.transition(c, RequestMachine, id, 'cancel', actor, { set: { cancelled_reason: reason ?? null, next_dispatch_check_at: null } });
      await this.closeOpenNegotiations(c, id, actor);
      await this.outbox.emit(c, Events.RequestCancelled, 'service_request', id, { requestId: id, reason }, r.market_id);
    });
    return this.get(actor, id);
  }

  /** Closes live quotes, open counter-offers and pending dispatches for a request. */
  async closeOpenNegotiations(c: Queryable, requestId: string, actor: Actor, exceptQuoteId?: string) {
    const sys: Actor = { userId: null, type: 'system' };
    const open = await this.db.many(
      `SELECT id FROM quotes WHERE service_request_id = $1 AND status IN ('submitted','active','countered') AND ($2::uuid IS NULL OR id <> $2)`,
      [requestId, exceptQuoteId ?? null], c);
    for (const qt of open) await this.state.transition(c, QuoteMachine, qt.id, 'close', sys, { metadata: { by: actor.type } });
    const counters = await this.db.many(
      `SELECT co.id FROM counter_offers co JOIN quotes q ON q.id = co.quote_id WHERE q.service_request_id = $1 AND co.status = 'proposed' AND ($2::uuid IS NULL OR q.id <> $2)`,
      [requestId, exceptQuoteId ?? null], c);
    for (const co of counters) await this.state.transition(c, CounterMachine, co.id, 'expire', sys);
    const dispatches = await this.db.many(
      `SELECT id FROM provider_dispatches WHERE service_request_id = $1 AND status IN ('candidate_identified','notified','viewed')`, [requestId], c);
    for (const dp of dispatches) await this.state.transition(c, DispatchMachine, dp.id, 'close', sys);
  }
}
