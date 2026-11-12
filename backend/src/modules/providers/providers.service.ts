import { Injectable } from '@nestjs/common';
import { isImplausibleJump, isValidCoordinate, LIVE_TRACKING_STATES } from '@trades/domain';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { encrypt } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { PlatformConfigService } from '../../common/platform-config.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { AuthService } from '../auth/auth.service';
import { MediaService } from '../media/media.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface ZoneInput {
  type: 'radius' | 'polygon';
  centerLat?: number; centerLng?: number; radiusM?: number;
  /** polygon ring as [lng, lat] pairs (GeoJSON order); closed automatically */
  coordinates?: [number, number][];
  city?: string; isPrimary?: boolean;
}

@Injectable()
export class ProvidersService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly auth: AuthService,
    private readonly cfg: PlatformConfigService,
    private readonly limits: RateLimitService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async updateProfile(a: Actor, d: { businessName?: string; bio?: string; yearsExperience?: number; languages?: string[]; maxConcurrentJobs?: number; instantAcceptEnabled?: boolean }) {
    await this.db.tx(async c => {
      await c.query(
        `UPDATE providers SET business_name = COALESCE($2, business_name), max_concurrent_jobs = COALESCE($3, max_concurrent_jobs),
                instant_accept_enabled = COALESCE($4, instant_accept_enabled) WHERE id = $1`,
        [a.userId, d.businessName ?? null, d.maxConcurrentJobs ?? null, d.instantAcceptEnabled ?? null]);
      await c.query(
        `UPDATE provider_profiles SET bio = COALESCE($2, bio), years_experience = COALESCE($3, years_experience), languages = COALESCE($4, languages)
          WHERE provider_id = $1`, [a.userId, d.bio ?? null, d.yearsExperience ?? null, d.languages ?? null]);
    });
    return this.getMine(a);
  }

  async getMine(a: Actor) {
    const p = await this.db.oneOrFail(
      `SELECT p.*, pp.bio, pp.years_experience, pp.languages, pp.background_check_status, pp.rejection_reason, u.full_name, u.status AS user_status
         FROM providers p JOIN provider_profiles pp ON pp.provider_id = p.id JOIN users u ON u.id = p.id WHERE p.id = $1`, [a.userId], undefined, 'Provider');
    const categories = await this.db.many(
      `SELECT psc.category_id, c.name, c.slug, c.requires_license, psc.approved, psc.price_band_min, psc.price_band_max, psc.rating_avg, psc.rating_count
         FROM provider_service_categories psc JOIN service_categories c ON c.id = psc.category_id WHERE psc.provider_id = $1 ORDER BY c.sort_order`, [a.userId]);
    const zones = await this.db.many(`SELECT id, zone_type, center_lat, center_lng, radius_meters, city, is_primary FROM service_zones WHERE provider_id = $1`, [a.userId]);
    const documents = await this.db.many(`SELECT id, kind, category_id, status, expires_at, notes, created_at FROM provider_documents WHERE provider_id = $1 ORDER BY created_at DESC`, [a.userId]);
    const payoutAccount = p.payout_account_id
      ? await this.db.one(`SELECT id, method, account_holder_name, bank_name, account_last4, verified, payouts_allowed_after FROM payout_accounts WHERE id = $1`, [p.payout_account_id])
      : null;
    const windows = await this.db.many(`SELECT id, weekday, start_time, end_time FROM provider_availability_windows WHERE provider_id = $1 ORDER BY weekday, start_time`, [a.userId]);
    return { ...p, categories, zones, documents, payoutAccount, availabilityWindows: windows, onboarding: this.onboardingChecklist(p, categories, zones, documents, payoutAccount) };
  }

  private onboardingChecklist(p: any, categories: any[], zones: any[], docs: any[], payout: any) {
    const has = (k: string) => docs.some(d => d.kind === k && d.status !== 'rejected');
    const licenceNeeded = categories.filter(c => c.requires_license);
    const items = {
      profile: !!p.bio,
      categories: categories.length > 0,
      location: p.home_base_lat !== null && zones.length > 0,
      identity: has('id_front') && has('selfie'),
      licences: licenceNeeded.every(c => docs.some(d => d.kind === 'license' && d.category_id === c.category_id && d.status !== 'rejected')),
      payoutAccount: !!payout,
    };
    return { ...items, complete: Object.values(items).every(Boolean) };
  }

  async setCategories(a: Actor, items: Array<{ categoryId: string; priceBandMin?: string; priceBandMax?: string }>) {
    if (!items.length || items.length > 10) throw new ValidationError('Choose between 1 and 10 categories');
    await this.db.tx(async c => {
      const ids = items.map(i => i.categoryId);
      const cats = await this.db.many(`SELECT id, requires_license FROM service_categories WHERE id = ANY($1) AND is_active`, [ids], c);
      if (cats.length !== new Set(ids).size) throw new ValidationError('Unknown or inactive category');
      await c.query(`DELETE FROM provider_service_categories WHERE provider_id = $1 AND NOT (category_id = ANY($2))`, [a.userId, ids]);
      for (const i of items) {
        const lic = cats.find(x => x.id === i.categoryId)!.requires_license;
        await c.query(
          `INSERT INTO provider_service_categories (provider_id, category_id, price_band_min, price_band_max, approved)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (provider_id, category_id) DO UPDATE SET price_band_min = EXCLUDED.price_band_min, price_band_max = EXCLUDED.price_band_max`,
          [a.userId, i.categoryId, i.priceBandMin ?? null, i.priceBandMax ?? null, !lic]);
      }
      await this.audit.log(c, a, 'provider.categories.set', 'provider', a.userId, null, { items });
    });
    return this.getMine(a);
  }

  async setLocations(a: Actor, d: { homeBase: { lat: number; lng: number }; zones: ZoneInput[] }) {
    if (!isValidCoordinate(d.homeBase.lat, d.homeBase.lng)) throw new ValidationError('Invalid home base');
    if (!d.zones.length || d.zones.length > 5) throw new ValidationError('Provide between 1 and 5 service zones');
    await this.db.tx(async c => {
      await c.query(`UPDATE providers SET home_base_lat = $2, home_base_lng = $3 WHERE id = $1`, [a.userId, d.homeBase.lat, d.homeBase.lng]);
      await c.query(`DELETE FROM service_zones WHERE provider_id = $1`, [a.userId]);
      for (const [i, z] of d.zones.entries()) {
        if (z.type === 'radius') {
          if (!isValidCoordinate(z.centerLat ?? NaN, z.centerLng ?? NaN) || !z.radiusM) throw new ValidationError('Radius zone needs centre and radius');
          await c.query(
            `INSERT INTO service_zones (provider_id, zone_type, center_lat, center_lng, radius_meters, city, is_primary) VALUES ($1,'radius',$2,$3,$4,$5,$6)`,
            [a.userId, z.centerLat, z.centerLng, Math.round(z.radiusM), z.city ?? null, z.isPrimary ?? i === 0]);
        } else {
          const ring = z.coordinates ?? [];
          if (ring.length < 3 || ring.length > 200 || ring.some(([lng, lat]) => !isValidCoordinate(lat, lng))) throw new ValidationError('Polygon needs 3–200 valid points');
          const closed = [...ring, ...(ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1] ? [ring[0]] : [])];
          const wkt = `SRID=4326;POLYGON((${closed.map(([lng, lat]) => `${lng} ${lat}`).join(', ')}))`;
          await c.query(
            `INSERT INTO service_zones (provider_id, zone_type, polygon_geog, city, is_primary) VALUES ($1,'polygon', ST_GeogFromText($2), $3, $4)`,
            [a.userId, wkt, z.city ?? null, z.isPrimary ?? i === 0]);
        }
      }
      await this.audit.log(c, a, 'provider.locations.set', 'provider', a.userId);
    });
    return this.getMine(a);
  }

  async setAvailability(a: Actor, status: 'online' | 'offline' | 'busy') {
    const p = await this.db.oneOrFail(`SELECT verification_status FROM providers WHERE id = $1`, [a.userId], undefined, 'Provider');
    if (status === 'online' && p.verification_status !== 'verified') throw new ForbiddenError('Your account must be verified before you can go online');
    const u = await this.db.one(`SELECT status FROM users WHERE id = $1`, [a.userId]);
    if (status === 'online' && u?.status !== 'active') throw new ForbiddenError('Your account is not active');
    await this.db.pool.query(`UPDATE providers SET availability_status = $2 WHERE id = $1`, [a.userId, status]);
    return { availabilityStatus: status };
  }

  /**
   * Location ingestion (§G). Battery-aware clients send every 30–120 s while online,
   * more often during an active job. Implausible jumps / mock locations raise a
   * fraud signal and are not used as the provider's position (§J spoofing).
   */
  async locationPing(a: Actor, d: { lat: number; lng: number; accuracyM?: number; isMocked?: boolean; recordedAt?: string; bookingId?: string }) {
    if (!isValidCoordinate(d.lat, d.lng)) throw new ValidationError('Invalid coordinates');
    await this.limits.enforce(`ping:${a.userId}`, 120, 60);
    const at = d.recordedAt ? new Date(d.recordedAt) : new Date();
    if (Math.abs(at.getTime() - Date.now()) > 10 * 60_000) throw new ValidationError('recordedAt is too far from server time');
    const prev = await this.db.one(`SELECT last_lat, last_lng, last_location_at FROM providers WHERE id = $1`, [a.userId]);
    const flagged = !!d.isMocked || (prev?.last_lat != null && isImplausibleJump(
      { lat: prev.last_lat, lng: prev.last_lng, at: new Date(prev.last_location_at) },
      { lat: d.lat, lng: d.lng, at, accuracyM: d.accuracyM, mocked: d.isMocked }));
    await this.db.tx(async c => {
      await c.query(
        `INSERT INTO provider_location_pings (provider_id, booking_id, lat, lng, accuracy_m, is_mocked, flagged, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.userId, d.bookingId ?? null, d.lat, d.lng, d.accuracyM ?? null, !!d.isMocked, flagged, at]);
      if (flagged) {
        await c.query(
          `INSERT INTO fraud_signals (subject_user_id, signal, severity, booking_id, details) VALUES ($1,$2,$3,$4,$5)`,
          [a.userId, d.isMocked ? 'mock_location' : 'location_jump', d.isMocked ? 4 : 3, d.bookingId ?? null,
           JSON.stringify({ prev: prev ? { lat: prev.last_lat, lng: prev.last_lng, at: prev.last_location_at } : null, next: { lat: d.lat, lng: d.lng, at } })]);
      } else {
        await c.query(`UPDATE providers SET last_lat = $2, last_lng = $3, last_location_at = $4 WHERE id = $1`, [a.userId, d.lat, d.lng, at]);
      }
    });
    if (!flagged && d.bookingId) {
      const b = await this.db.one(`SELECT id, status FROM bookings WHERE id = $1 AND provider_id = $2`, [d.bookingId, a.userId]);
      if (b && (LIVE_TRACKING_STATES as readonly string[]).includes(b.status)) {
        this.realtime.toBooking(b.id, 'provider.location', { lat: d.lat, lng: d.lng, accuracyM: d.accuracyM, at });
      }
    }
    return { accepted: !flagged };
  }

  async addDocument(a: Actor, d: { kind: string; storageKey: string; categoryId?: string; expiresAt?: string }) {
    this.media.assertOwnedBy(d.storageKey, a.userId!);
    return this.db.tx(async c => {
      const doc = await this.db.one(
        `INSERT INTO provider_documents (provider_id, kind, category_id, storage_key, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, status, created_at`,
        [a.userId, d.kind, d.categoryId ?? null, d.storageKey, d.expiresAt ?? null], c);
      if (d.kind === 'license' && d.expiresAt) await c.query(`UPDATE provider_profiles SET license_expires_at = $2 WHERE provider_id = $1`, [a.userId, d.expiresAt]);
      await this.audit.log(c, a, 'provider.document.upload', 'provider_document', doc!.id, null, { kind: d.kind });
      return doc;
    });
  }

  async submitForVerification(a: Actor) {
    const mine = await this.getMine(a);
    const { complete, ...items } = mine.onboarding;
    if (!complete) throw new ValidationError('Complete your profile before submitting', items);
    if (mine.verification_status === 'verified') return { verificationStatus: 'verified' };
    await this.db.tx(async c => {
      await c.query(`UPDATE providers SET verification_status = 'pending' WHERE id = $1`, [a.userId]);
      await c.query(`UPDATE provider_profiles SET background_check_status = CASE WHEN EXISTS (
          SELECT 1 FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id
           WHERE psc.provider_id = $1 AND sc.requires_background_check) AND background_check_status = 'n/a' THEN 'pending' ELSE background_check_status END
        WHERE provider_id = $1`, [a.userId]);
      await this.audit.log(c, a, 'provider.submit_verification', 'provider', a.userId);
    });
    return { verificationStatus: 'pending' };
  }

  /**
   * Payout account change requires a fresh step-up OTP and starts a cooling-off
   * period during which payouts to the new account are held (§J account-takeover defence).
   */
  async setPayoutAccount(a: Actor, d: { method: 'bank_transfer' | 'mobile_wallet'; accountHolderName: string; bankName?: string; accountNumber: string; bankCode?: string; stepUpCode: string }) {
    const digits = d.accountNumber.replace(/\s/g, '');
    if (!/^[A-Z0-9]{6,34}$/i.test(digits)) throw new ValidationError('Invalid account number / IBAN');
    const cooloff = Number(await this.cfg.get<number>('payout_account_cooloff_sec', 86400));
    return this.db.tx(async c => {
      await this.auth.completeStepUp(a, d.stepUpCode, c);
      const prev = await this.db.one(`SELECT payout_account_id FROM providers WHERE id = $1`, [a.userId], c);
      await c.query(`UPDATE payout_accounts SET disabled_at = now(), is_default = false WHERE provider_id = $1 AND disabled_at IS NULL`, [a.userId]);
      const acct = await this.db.one(
        `INSERT INTO payout_accounts (provider_id, method, account_holder_name, bank_name, account_last4, account_details_encrypted, payouts_allowed_after)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))
         RETURNING id, method, account_holder_name, bank_name, account_last4, verified, payouts_allowed_after`,
        [a.userId, d.method, d.accountHolderName, d.bankName ?? null, digits.slice(-4),
         encrypt(JSON.stringify({ accountNumber: digits, bankCode: d.bankCode ?? null })), prev?.payout_account_id ? cooloff : 0], c);
      await c.query(`UPDATE providers SET payout_account_id = $2 WHERE id = $1`, [a.userId, acct!.id]);
      // Re-point pending payouts to the new account; they inherit the cool-off via payouts_allowed_after.
      await c.query(`UPDATE payout_records SET payout_account_id = $2 WHERE provider_id = $1 AND status IN ('payout_pending','held')`, [a.userId, acct!.id]);
      await this.audit.log(c, a, 'provider.payout_account.change', 'payout_account', acct!.id, prev, { last4: acct!.account_last4, method: d.method });
      if (prev?.payout_account_id) {
        await c.query(`INSERT INTO fraud_signals (subject_user_id, signal, severity, details) VALUES ($1,'payout_account_change',2,$2)`,
          [a.userId, JSON.stringify({ newAccountLast4: acct!.account_last4 })]);
      }
      return acct;
    });
  }

  async earnings(a: Actor) {
    const summary = await this.db.one(
      `SELECT currency_code,
              COALESCE(SUM(net_payout_amount) FILTER (WHERE status IN ('released','settled')), 0) AS paid_out,
              COALESCE(SUM(net_payout_amount) FILTER (WHERE status IN ('payout_pending','processing')), 0) AS pending,
              COALESCE(SUM(net_payout_amount) FILTER (WHERE status = 'held'), 0) AS held,
              COALESCE(SUM(commission_deducted), 0) AS commission_paid,
              COUNT(*)::int AS jobs
         FROM payout_records WHERE provider_id = $1 GROUP BY currency_code`, [a.userId]);
    const clawbacks = await this.db.one(
      `SELECT COALESCE(SUM(amount - recovered_amount), 0) AS outstanding FROM provider_clawbacks WHERE provider_id = $1 AND status IN ('open','recovering')`, [a.userId]);
    const payouts = await this.db.many(
      `SELECT pr.id, pr.booking_id, b.reference, pr.gross_amount, pr.commission_deducted, pr.net_payout_amount, pr.clawback_recovered,
              pr.currency_code, pr.status, pr.eligible_at, pr.released_at, pr.hold_reason
         FROM payout_records pr JOIN bookings b ON b.id = pr.booking_id WHERE pr.provider_id = $1 ORDER BY pr.created_at DESC LIMIT 100`, [a.userId]);
    return { summary, clawbackOutstanding: clawbacks?.outstanding ?? '0', payouts };
  }

  async setAvailabilityWindows(a: Actor, windows: Array<{ weekday: number; start: string; end: string }>) {
    await this.db.tx(async c => {
      await c.query(`DELETE FROM provider_availability_windows WHERE provider_id = $1`, [a.userId]);
      for (const w of windows) {
        await c.query(`INSERT INTO provider_availability_windows (provider_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)`, [a.userId, w.weekday, w.start, w.end]);
      }
    });
    return this.db.many(`SELECT id, weekday, start_time, end_time FROM provider_availability_windows WHERE provider_id = $1 ORDER BY weekday, start_time`, [a.userId]);
  }

  async addTimeOff(a: Actor, startsAt: string, endsAt: string) {
    if (new Date(startsAt) >= new Date(endsAt)) throw new ValidationError('Time off must end after it starts');
    return this.db.one(`INSERT INTO provider_time_off (provider_id, starts_at, ends_at) VALUES ($1,$2,$3) RETURNING *`, [a.userId, startsAt, endsAt]);
  }

  /** Public provider profile shown to customers (no contact details, no exact location). */
  async publicProfile(providerId: string) {
    const p = await this.db.one(
      `SELECT u.id, u.full_name, u.avatar_url, p.business_name, p.rating_avg, p.rating_count, p.verification_status,
              pp.bio, pp.years_experience, pp.languages, u.created_at AS member_since,
              (SELECT count(*)::int FROM bookings b WHERE b.provider_id = p.id AND b.status IN ('payout_pending','payout_released')) AS jobs_completed
         FROM providers p JOIN users u ON u.id = p.id JOIN provider_profiles pp ON pp.provider_id = p.id
        WHERE p.id = $1 AND u.deleted_at IS NULL`, [providerId]);
    if (!p) throw new NotFoundError('Provider not found');
    const categories = await this.db.many(
      `SELECT c.id, c.name, psc.rating_avg, psc.rating_count FROM provider_service_categories psc JOIN service_categories c ON c.id = psc.category_id
        WHERE psc.provider_id = $1 AND psc.approved`, [providerId]);
    const reviews = await this.db.many(
      `SELECT r.rating, r.comment, r.category_breakdown, r.created_at, split_part(u.full_name, ' ', 1) AS reviewer_first_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_user_id
        WHERE r.reviewee_user_id = $1 AND r.reviewer_role = 'customer' AND NOT r.is_hidden AND r.visible_at <= now()
        ORDER BY r.created_at DESC LIMIT 20`, [providerId]);
    return { ...p, verified: p.verification_status === 'verified', categories, reviews };
  }
}
