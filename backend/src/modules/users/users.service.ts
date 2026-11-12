import { Injectable } from '@nestjs/common';
import { approximateLocation, isValidCoordinate } from '@trades/domain';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService } from '../../common/db.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { MediaService } from '../media/media.service';

export interface AddressInput {
  label?: string; line1: string; line2?: string; city: string; postalCode?: string; countryCode?: string;
  accessNotes?: string; lat: number; lng: number; precisionLevel?: 'exact' | 'approximate'; makeDefault?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly media: MediaService) {}

  async me(actor: Actor) {
    const u = await this.db.oneOrFail(
      `SELECT id, phone_number, email, full_name, avatar_url, user_type, status, country_code, market_id, locale,
              phone_verified_at, created_at FROM users WHERE id = $1`, [actor.userId], undefined, 'User');
    let extra: any = {};
    if (u.user_type === 'customer') {
      extra = await this.db.one(`SELECT default_address_id, rating_avg, rating_count FROM customers WHERE id = $1`, [u.id]);
    } else if (u.user_type === 'provider') {
      extra = await this.db.one(
        `SELECT p.business_name, p.verification_status, p.availability_status, p.max_concurrent_jobs, p.current_active_jobs,
                p.rating_avg, p.rating_count, p.instant_accept_enabled, p.home_base_lat, p.home_base_lng, p.payout_account_id,
                pp.bio, pp.years_experience, pp.languages, pp.background_check_status, pp.rejection_reason
           FROM providers p JOIN provider_profiles pp ON pp.provider_id = p.id WHERE p.id = $1`, [u.id]);
    }
    const market = u.market_id ? await this.db.one(`SELECT id, country_code, city, currency_code, timezone FROM markets WHERE id = $1`, [u.market_id]) : null;
    return { ...u, ...extra, market };
  }

  async updateMe(actor: Actor, d: { fullName?: string; email?: string; locale?: string; avatarKey?: string }) {
    if (d.avatarKey) this.media.assertOwnedBy(d.avatarKey, actor.userId!);
    try {
      await this.db.pool.query(
        `UPDATE users SET full_name = COALESCE($2, full_name), email = COALESCE($3, email), locale = COALESCE($4, locale),
                avatar_url = COALESCE($5, avatar_url) WHERE id = $1`,
        [actor.userId, d.fullName?.trim() ?? null, d.email?.toLowerCase() ?? null, d.locale ?? null, d.avatarKey ?? null]);
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictError('That email is already in use');
      throw e;
    }
    return this.me(actor);
  }

  /**
   * Right-to-erasure request: anonymises PII while retaining financial/KYC records
   * required by law (ledger, payments, audit) — §J PII protection.
   */
  async deleteAccount(actor: Actor) {
    return this.db.tx(async c => {
      const open = await this.db.one(
        `SELECT count(*)::int AS n FROM bookings WHERE (customer_id = $1 OR provider_id = $1)
           AND status NOT IN ('payout_released','refunded','cancelled')`, [actor.userId], c);
      if (open!.n > 0) throw new ConflictError('You have bookings in progress. Complete or cancel them before deleting your account.');
      await c.query(
        `UPDATE users SET full_name = 'Deleted user', email = NULL, phone_number = NULL, avatar_url = NULL, password_hash = NULL,
                status = 'suspended', deleted_at = now()
          WHERE id = $1`, [actor.userId]);
      await c.query(`UPDATE addresses SET deleted_at = now(), line1 = '[deleted]', line2 = NULL, access_notes = NULL WHERE owner_user_id = $1`, [actor.userId]);
      await c.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'account_deleted' WHERE user_id = $1 AND revoked_at IS NULL`, [actor.userId]);
      await c.query(`UPDATE push_tokens SET disabled_at = now() WHERE user_id = $1`, [actor.userId]);
      await this.audit.log(c, actor, 'user.delete_account', 'user', actor.userId);
      return { ok: true };
    });
  }

  /* ───────────── addresses ───────────── */

  listAddresses(actor: Actor) {
    return this.db.many(
      `SELECT a.*, (c.default_address_id = a.id) AS is_default FROM addresses a LEFT JOIN customers c ON c.id = a.owner_user_id
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`, [actor.userId]);
  }

  async createAddress(actor: Actor, d: AddressInput) {
    if (!isValidCoordinate(d.lat, d.lng)) throw new ValidationError('Invalid coordinates');
    return this.db.tx(async c => {
      const row = await this.db.one(
        `INSERT INTO addresses (owner_user_id, label, line1, line2, city, postal_code, country_code, access_notes, lat, lng, precision_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [actor.userId, d.label ?? 'Home', d.line1, d.line2 ?? null, d.city, d.postalCode ?? null, d.countryCode ?? 'MU',
         d.accessNotes ?? null, d.lat, d.lng, d.precisionLevel ?? 'approximate'], c);
      const count = await this.db.one(`SELECT count(*)::int AS n FROM addresses WHERE owner_user_id = $1 AND deleted_at IS NULL`, [actor.userId], c);
      if (d.makeDefault || count!.n === 1) await c.query(`UPDATE customers SET default_address_id = $2 WHERE id = $1`, [actor.userId, row!.id]);
      return row;
    });
  }

  async updateAddress(actor: Actor, id: string, d: Partial<AddressInput>) {
    if ((d.lat !== undefined || d.lng !== undefined) && !isValidCoordinate(d.lat ?? NaN, d.lng ?? NaN)) throw new ValidationError('Invalid coordinates');
    const row = await this.db.one(
      `UPDATE addresses SET label = COALESCE($3,label), line1 = COALESCE($4,line1), line2 = COALESCE($5,line2), city = COALESCE($6,city),
              postal_code = COALESCE($7,postal_code), access_notes = COALESCE($8,access_notes), lat = COALESCE($9,lat), lng = COALESCE($10,lng),
              precision_level = COALESCE($11,precision_level)
        WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL RETURNING *`,
      [id, actor.userId, d.label ?? null, d.line1 ?? null, d.line2 ?? null, d.city ?? null, d.postalCode ?? null, d.accessNotes ?? null,
       d.lat ?? null, d.lng ?? null, d.precisionLevel ?? null]);
    if (!row) throw new NotFoundError('Address not found');
    if (d.makeDefault) await this.db.pool.query(`UPDATE customers SET default_address_id = $2 WHERE id = $1`, [actor.userId, id]);
    return row;
  }

  async deleteAddress(actor: Actor, id: string) {
    const r = await this.db.pool.query(`UPDATE addresses SET deleted_at = now() WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`, [id, actor.userId]);
    if (!r.rowCount) throw new NotFoundError('Address not found');
    await this.db.pool.query(`UPDATE customers SET default_address_id = NULL WHERE id = $1 AND default_address_id = $2`, [actor.userId, id]);
    return { ok: true };
  }

  /** Public, privacy-safe preview of a location (shown before acceptance, §G.7). */
  static approximate(lat: number, lng: number) { return approximateLocation(lat, lng); }
}
