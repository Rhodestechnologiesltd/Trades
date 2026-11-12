import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  Candidate, DispatchMachine, RequestMachine, RequestMode, approximateLocation, etaMinutes, nextRadius, rankCandidates, selectWave,
} from '@trades/domain';
import { Actor, SYSTEM_ACTOR } from '../../common/auth';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { DomainEvent, Events, OutboxService } from '../../common/outbox.service';
import { clampLimit } from '../../common/pagination';
import { PlatformConfigService } from '../../common/platform-config.service';
import { StateService } from '../../common/state.service';

/**
 * Geolocation & Dispatch (spec §G). Hard filters run in SQL (find_dispatch_candidates);
 * ranking, staggered waves and radius expansion are driven by @trades/domain policies.
 */
@Injectable()
export class DispatchService {
  private readonly log = new Logger('Dispatch');

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly outbox: OutboxService,
    private readonly cfg: PlatformConfigService,
  ) {}

  @OnEvent(Events.RequestCreated, { async: true })
  async onRequestCreated(evt: DomainEvent<{ requestId: string; dispatchNow: boolean }>) {
    if (!evt.payload.dispatchNow) return; // scheduled far ahead → the sweep dispatches closer to the date
    await this.runMatching(evt.payload.requestId).catch(e => this.log.error(`matching ${evt.payload.requestId}: ${e.message}`));
  }

  /**
   * One matching pass: find eligible candidates at the current radius, expanding
   * immediately while fewer than minCandidates are available, then notify the
   * next ranked wave. Idempotent: providers are never notified twice for a request.
   */
  async runMatching(requestId: string): Promise<{ notified: number; radiusM: number; status: string }> {
    return this.db.tx(async c => {
      const r = await this.db.one(
        `SELECT r.*, c.name AS category_name, c.instant_accept_price, l.area_label, m.max_dispatch_radius_m
           FROM service_requests r JOIN service_categories c ON c.id = r.category_id JOIN request_locations l ON l.service_request_id = r.id
           JOIN markets m ON m.id = r.market_id WHERE r.id = $1 FOR UPDATE OF r`, [requestId], c);
      if (!r) throw new NotFoundError('Request not found');
      if (!['requested', 'dispatched', 'quoted'].includes(r.status)) return { notified: 0, radiusM: r.current_search_radius_m, status: r.status };

      const mode = r.request_mode as RequestMode;
      const policy = await this.cfg.dispatchPolicy(mode);
      const weights = await this.cfg.rankingWeights(mode);
      const maxRadius = Math.min(policy.maxRadiusM, r.max_dispatch_radius_m);
      const effectivePolicy = { ...policy, maxRadiusM: maxRadius };

      if (r.status === 'requested') await this.state.transition(c, RequestMachine, r.id, 'start_matching', SYSTEM_ACTOR);
      else if (r.status === 'dispatched') await this.state.transition(c, RequestMachine, r.id, 'expand_radius', SYSTEM_ACTOR, { metadata: { radius: r.current_search_radius_m } });

      const already = new Set<string>((await this.db.many(`SELECT provider_id FROM provider_dispatches WHERE service_request_id = $1`, [r.id], c)).map(x => x.provider_id));
      let radius: number = r.current_search_radius_m;
      let ranked: Array<Candidate & { score: number; instantAccept: boolean }> = [];
      for (;;) {
        const rows = await this.db.many(`SELECT * FROM find_dispatch_candidates($1, $2, $3, 300)`, [r.id, radius, mode === 'urgent'], c);
        ranked = rankCandidates(rows.map(this.toCandidate), maxRadius, weights).map(x => ({ ...x, instantAccept: rows.find(y => y.provider_id === x.providerId)?.instant_accept_enabled }));
        const fresh = ranked.filter(x => !already.has(x.providerId));
        if (fresh.length >= policy.minCandidates || (fresh.length > 0 && r.status !== 'requested')) break;
        const nr = nextRadius(radius, effectivePolicy);
        if (nr === null) break;
        radius = nr;
      }
      const wave = selectWave(ranked, already, policy.waveSize);
      const waveNo = r.dispatch_wave + 1;
      const now = Date.now();
      const nextCheck = new Date(now + policy.responseSlaSec * 1000);

      if (!wave.length) {
        if (r.status === 'quoted') {
          // Quotes already on the table: stop widening, let the customer choose.
          await c.query(`UPDATE service_requests SET current_search_radius_m = $2, next_dispatch_check_at = NULL WHERE id = $1`, [r.id, radius]);
          return { notified: 0, radiusM: radius, status: 'quoted' };
        }
        if (already.size === 0) {
          // §G.2: nobody eligible even at max radius → expired ("no providers currently available"),
          // flagged for manual admin assist when urgent.
          await this.state.transition(c, RequestMachine, r.id, 'no_providers', SYSTEM_ACTOR, {
            set: { current_search_radius_m: radius, next_dispatch_check_at: null, admin_assist_requested: mode === 'urgent' },
          });
          await this.outbox.emit(c, Events.RequestExpired, 'service_request', r.id,
            { requestId: r.id, customerId: r.customer_id, categoryName: r.category_name, adminAssist: mode === 'urgent' }, r.market_id);
          return { notified: 0, radiusM: radius, status: 'expired' };
        }
        // Everyone reachable has been notified; keep waiting for responses until the request expires.
        await this.state.transition(c, RequestMachine, r.id, 'providers_found', SYSTEM_ACTOR, {
          set: { current_search_radius_m: radius, next_dispatch_check_at: radius >= maxRadius ? null : nextCheck, admin_assist_requested: mode === 'urgent' && radius >= maxRadius },
        });
        return { notified: 0, radiusM: radius, status: 'dispatched' };
      }

      for (const cand of wave) {
        const d = await this.db.one(
          `INSERT INTO provider_dispatches (service_request_id, provider_id, status, wave, rank_score, distance_m, notified_at, response_deadline)
           VALUES ($1,$2,'notified',$3,$4,$5, now(), $6) ON CONFLICT (service_request_id, provider_id) DO NOTHING RETURNING id`,
          [r.id, cand.providerId, waveNo, cand.score, cand.distanceM, nextCheck], c);
        if (!d) continue;
        await this.state.created(c, 'provider_dispatch', d.id, 'notified', SYSTEM_ACTOR, { wave: waveNo, score: cand.score });
        await this.outbox.emit(c, Events.ProviderNotified, 'service_request', r.id, {
          requestId: r.id, providerId: cand.providerId, categoryName: r.category_name, area: r.area_label,
          distanceKm: Math.round(cand.distanceM / 100) / 10, etaMin: etaMinutes(cand.distanceM), urgent: mode === 'urgent',
          instantAcceptPrice: mode === 'urgent' && cand.instantAccept ? r.instant_accept_price : null, wave: waveNo,
        }, r.market_id);
      }
      await c.query(`UPDATE service_requests SET current_search_radius_m = $2, dispatch_wave = $3, next_dispatch_check_at = $4 WHERE id = $1`,
        [r.id, radius, waveNo, nextCheck]);
      if (r.status !== 'quoted') await this.state.transition(c, RequestMachine, r.id, 'providers_found', SYSTEM_ACTOR);
      await this.outbox.emit(c, Events.RequestDispatched, 'service_request', r.id,
        { requestId: r.id, customerId: r.customer_id, notified: already.size + wave.length, categoryName: r.category_name, radiusKm: radius / 1000 }, r.market_id);
      return { notified: wave.length, radiusM: radius, status: r.status === 'quoted' ? 'quoted' : 'dispatched' };
    });
  }

  private toCandidate = (row: any): Candidate => ({
    providerId: row.provider_id,
    distanceM: row.distance_m,
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    ratingCount: row.rating_count ?? 0,
    activeJobs: row.active_jobs,
    maxConcurrentJobs: row.max_concurrent_jobs,
    responseSpeedAvgSec: row.response_speed_avg_sec,
    urgentCompletionRate: row.urgent_completion_rate === null ? null : Number(row.urgent_completion_rate),
    quoteConversionRate: row.quote_conversion_rate === null ? null : Number(row.quote_conversion_rate),
    noShowCount: row.no_show_count,
  });

  /**
   * Scheduler sweep (§G.2): time out non-responders, then expand / dispatch the next
   * wave for requests whose SLA window elapsed, and expire stale requests.
   */
  async sweep(limit = 50): Promise<number> {
    // 1) dispatch rows past their response deadline → expired_no_response
    const timedOut = await this.db.many(
      `SELECT id FROM provider_dispatches WHERE status IN ('notified','viewed') AND response_deadline < now() LIMIT 500`);
    for (const d of timedOut) {
      await this.db.tx(c => this.state.transition(c, DispatchMachine, d.id, 'timeout', SYSTEM_ACTOR, { set: { responded_at: new Date() } })).catch(() => undefined);
    }
    // 2) overall request expiry
    const stale = await this.db.many(
      `SELECT id, status FROM service_requests WHERE status IN ('requested','matching','dispatched','quoted') AND expires_at IS NOT NULL AND expires_at < now() LIMIT 200`);
    for (const r of stale) {
      await this.db.tx(async c => {
        const trigger = r.status === 'dispatched' ? 'sla_timeout' : r.status === 'quoted' ? 'expire' : 'cancel';
        await this.state.transition(c, RequestMachine, r.id, trigger as any, SYSTEM_ACTOR, { set: { next_dispatch_check_at: null } });
        const full = await this.db.one(`SELECT r.customer_id, r.market_id, c.name FROM service_requests r JOIN service_categories c ON c.id = r.category_id WHERE r.id = $1`, [r.id], c);
        await this.outbox.emit(c, Events.RequestExpired, 'service_request', r.id, { requestId: r.id, customerId: full!.customer_id, categoryName: full!.name }, full!.market_id);
      }).catch(e => this.log.warn(`expire ${r.id}: ${e.message}`));
    }
    // 3) due dispatch checks (urgent first, §G.4 queue priority)
    const due = await this.db.many(
      `SELECT id FROM service_requests WHERE status IN ('requested','dispatched') AND next_dispatch_check_at <= now()
        ORDER BY (request_mode = 'urgent') DESC, next_dispatch_check_at LIMIT $1`, [limit]);
    for (const r of due) await this.runMatching(r.id).catch(e => this.log.warn(`sweep ${r.id}: ${e.message}`));
    return due.length + timedOut.length + stale.length;
  }

  /* ───────────── provider actions ───────────── */

  async decline(a: Actor, requestId: string, reason?: string) {
    return this.db.tx(async c => {
      const d = await this.db.one(`SELECT id FROM provider_dispatches WHERE service_request_id = $1 AND provider_id = $2`, [requestId, a.userId], c);
      if (!d) throw new NotFoundError('Request was not sent to you');
      // Declining an urgent job never penalises ranking (§K abuse of urgent requests)
      await this.state.transition(c, DispatchMachine, d.id, 'decline', a, { set: { responded_at: new Date(), decline_reason: reason ?? null } });
      await this.maybeTriggerNextWave(c, requestId);
      return { ok: true };
    });
  }

  /** If everyone in the current wave declined, bring the next wave forward. */
  private async maybeTriggerNextWave(c: Queryable, requestId: string) {
    const pending = await this.db.one(
      `SELECT count(*)::int AS n FROM provider_dispatches WHERE service_request_id = $1 AND status IN ('notified','viewed')`, [requestId], c);
    if (pending!.n === 0) await c.query(`UPDATE service_requests SET next_dispatch_check_at = now() WHERE id = $1 AND status = 'dispatched'`, [requestId]);
  }

  /** Provider job feed: requests dispatched to me + open requests I am eligible for (approximate locations only). */
  async jobsForProvider(a: Actor, opts: { lat?: number; lng?: number; radiusM?: number; limit?: number }) {
    const p = await this.db.oneOrFail(`SELECT verification_status FROM providers WHERE id = $1`, [a.userId], undefined, 'Provider');
    if (p.verification_status !== 'verified') return { dispatched: [], open: [] };
    const dispatched = await this.db.many(
      `SELECT r.id, r.title, r.request_mode, r.status, r.scheduled_for, r.urgency_level, r.budget_hint, r.currency_code, r.created_at,
              c.name AS category_name, c.icon AS category_icon, l.approx_lat, l.approx_lng, l.area_label,
              pd.status AS dispatch_status, pd.distance_m, pd.response_deadline,
              (SELECT q.status FROM quotes q WHERE q.service_request_id = r.id AND q.provider_id = $1 ORDER BY q.created_at DESC LIMIT 1) AS my_quote_status
         FROM provider_dispatches pd JOIN service_requests r ON r.id = pd.service_request_id
         JOIN service_categories c ON c.id = r.category_id JOIN request_locations l ON l.service_request_id = r.id
        WHERE pd.provider_id = $1 AND r.status IN ('dispatched','quoted') AND pd.status IN ('notified','viewed','quoted')
        ORDER BY (r.request_mode = 'urgent') DESC, pd.notified_at DESC LIMIT 100`, [a.userId]);
    const radius = Math.min(opts.radiusM ?? 25000, 60000);
    const open = await this.db.many(
      `SELECT r.id, r.title, r.request_mode, r.status, r.scheduled_for, r.urgency_level, r.budget_hint, r.currency_code, r.created_at,
              c.name AS category_name, c.icon AS category_icon, l.approx_lat, l.approx_lng, l.area_label,
              ST_Distance(COALESCE(p.last_geog, p.home_base_geog), l.geog)::int AS distance_m
         FROM service_requests r JOIN request_locations l ON l.service_request_id = r.id
         JOIN service_categories c ON c.id = r.category_id
         JOIN providers p ON p.id = $1
         JOIN users u ON u.id = p.id
        WHERE r.status IN ('dispatched','quoted') AND r.market_id = u.market_id AND r.customer_id <> $1
          AND NOT EXISTS (SELECT 1 FROM provider_dispatches pd WHERE pd.service_request_id = r.id AND pd.provider_id = $1)
          AND ST_DWithin(COALESCE(p.last_geog, p.home_base_geog), l.geog, $2)
          AND EXISTS (SELECT 1 FROM find_dispatch_candidates(r.id, $2, false, 1000) fc WHERE fc.provider_id = $1)
        ORDER BY r.created_at DESC LIMIT $3`, [a.userId, radius, clampLimit(opts.limit, 50, 30)]);
    return {
      dispatched: dispatched.map(x => ({ ...x, eta_min: etaMinutes(x.distance_m) })),
      open: open.map(x => ({ ...x, eta_min: etaMinutes(x.distance_m) })),
    };
  }

  /**
   * Ensures a provider may quote on a request: either dispatched to them, or
   * eligible under the hard filters (zone/category/verification) — §G.6.
   * Creates the dispatch row for organic (browse) quotes so metrics stay complete.
   */
  async assertEligibleToQuote(c: Queryable, requestId: string, providerId: string): Promise<{ dispatchId: string; distanceM: number; notifiedAt: Date; status: string }> {
    const d = await this.db.one(`SELECT * FROM provider_dispatches WHERE service_request_id = $1 AND provider_id = $2 FOR UPDATE`, [requestId, providerId], c);
    if (d) {
      if (d.status === 'quoted') {
        const live = await this.db.one(`SELECT 1 FROM quotes WHERE service_request_id = $1 AND provider_id = $2 AND status IN ('submitted','active','countered','accepted')`, [requestId, providerId], c);
        if (live) throw new ConflictError('You already have a live quote on this request. Withdraw it to send a new one.', 'quote_exists');
        return { dispatchId: d.id, distanceM: d.distance_m, notifiedAt: d.notified_at, status: d.status };
      }
      if (!['notified', 'viewed'].includes(d.status)) throw new ValidationError(`You can no longer quote on this request (${d.status.replace(/_/g, ' ')})`);
      return { dispatchId: d.id, distanceM: d.distance_m, notifiedAt: d.notified_at, status: d.status };
    }
    const elig = await this.db.one(`SELECT * FROM find_dispatch_candidates($1, 100000, false, 1000) WHERE provider_id = $2`, [requestId, providerId], c);
    if (!elig) throw new ForbiddenError('This job is outside your categories or service zones');
    const row = await this.db.one(
      `INSERT INTO provider_dispatches (service_request_id, provider_id, status, wave, distance_m, notified_at, viewed_at)
       VALUES ($1,$2,'viewed',0,$3, now(), now()) RETURNING id, notified_at`, [requestId, providerId, elig.distance_m], c);
    await this.state.created(c, 'provider_dispatch', row!.id, 'viewed', { userId: providerId, type: 'provider' }, { organic: true });
    return { dispatchId: row!.id, distanceM: elig.distance_m, notifiedAt: row!.notified_at, status: 'viewed' };
  }

  /* ───────────── map search & admin ───────────── */

  /** Customer map (§E /v1/geo/providers): approximate provider positions only. */
  async providersNear(lat: number, lng: number, radiusM: number, categoryId?: string) {
    const rows = await this.db.many(
      `SELECT p.id, u.full_name, p.business_name, p.rating_avg, p.rating_count, p.availability_status, p.home_base_lat, p.home_base_lng,
              ST_Distance(p.home_base_geog, make_geog($1,$2))::int AS distance_m
         FROM providers p JOIN users u ON u.id = p.id
        WHERE p.verification_status = 'verified' AND u.status = 'active'
          AND ST_DWithin(p.home_base_geog, make_geog($1,$2), $3)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id
                 WHERE psc.provider_id = p.id AND psc.approved AND (psc.category_id = $4 OR sc.id = (SELECT parent_id FROM service_categories WHERE id = $4))))
        ORDER BY distance_m LIMIT 100`, [lat, lng, Math.min(radiusM, 50000), categoryId ?? null]);
    return rows.map(r => {
      const approx = approximateLocation(r.home_base_lat, r.home_base_lng, 800);
      return { id: r.id, name: r.business_name || r.full_name, rating: r.rating_avg, ratingCount: r.rating_count, online: r.availability_status === 'online', approxLat: approx.lat, approxLng: approx.lng, distanceM: r.distance_m };
    });
  }

  /** Admin / system: raw nearby-provider search with eligibility diagnostics. */
  async adminNearby(lat: number, lng: number, radiusM: number, categoryId?: string) {
    return this.db.many(
      `SELECT p.id, u.full_name, u.status AS user_status, p.verification_status, p.availability_status, p.current_active_jobs, p.max_concurrent_jobs,
              p.rating_avg, p.no_show_count, p.last_lat, p.last_lng, p.last_location_at,
              ST_Distance(COALESCE(p.last_geog, p.home_base_geog), make_geog($1,$2))::int AS distance_m,
              ARRAY(SELECT sc.name FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id WHERE psc.provider_id = p.id) AS categories
         FROM providers p JOIN users u ON u.id = p.id
        WHERE ST_DWithin(COALESCE(p.last_geog, p.home_base_geog), make_geog($1,$2), $3)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM provider_service_categories psc WHERE psc.provider_id = p.id AND psc.category_id = $4))
        ORDER BY distance_m LIMIT 200`, [lat, lng, radiusM, categoryId ?? null]);
  }

  async dispatchLog(requestId: string) {
    return this.db.many(
      `SELECT pd.*, u.full_name FROM provider_dispatches pd JOIN users u ON u.id = pd.provider_id WHERE pd.service_request_id = $1 ORDER BY pd.wave, pd.rank_score DESC NULLS LAST`, [requestId]);
  }
}
