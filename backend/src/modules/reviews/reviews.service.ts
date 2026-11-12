import { Injectable } from '@nestjs/common';
import { moderateText, reviewVisibleAt } from '@trades/domain';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';

const CUSTOMER_DIMENSIONS = ['quality', 'punctuality', 'professionalism', 'value'];
const PROVIDER_DIMENSIONS = ['payment_promptness', 'site_readiness', 'respectfulness'];
const REVIEWABLE = ['completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released', 'disputed', 'refunded'];

/**
 * Two-way, double-blind reviews (§A.9): neither side sees the other's review until
 * both have reviewed or the window closes. Ratings are category-specific and feed
 * dispatch ranking. Text is moderated (PII redaction + profanity flag).
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly db: DbService, private readonly outbox: OutboxService, private readonly audit: AuditService, private readonly cfg: PlatformConfigService) {}

  async create(a: Actor, d: { bookingId: string; rating: number; comment?: string; breakdown?: Record<string, number> }) {
    if (!Number.isInteger(d.rating) || d.rating < 1 || d.rating > 5) throw new ValidationError('Rating must be 1–5');
    return this.db.tx(async c => {
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1`, [d.bookingId], c, 'Booking');
      const role = b.customer_id === a.userId ? 'customer' : b.provider_id === a.userId ? 'provider' : null;
      if (!role) throw new ForbiddenError();
      if (!REVIEWABLE.includes(b.status) || !b.job_completed_at) throw new ConflictError('You can review once the job is completed');
      const timing = await this.cfg.timing();
      if (Date.now() > new Date(b.job_completed_at).getTime() + timing.reviewWindowSec * 1000) throw new ConflictError('The review window has closed');
      const allowed = role === 'customer' ? CUSTOMER_DIMENSIONS : PROVIDER_DIMENSIONS;
      const breakdown = Object.fromEntries(Object.entries(d.breakdown ?? {}).filter(([k, v]) => allowed.includes(k) && Number.isInteger(v) && v >= 1 && v <= 5));
      const mod = d.comment ? moderateText(d.comment.trim().slice(0, 2000)) : null;
      const reviewee = role === 'customer' ? b.provider_id : b.customer_id;
      const counterpart = await this.db.one(`SELECT id, created_at FROM reviews WHERE booking_id = $1 AND reviewer_user_id = $2 FOR UPDATE`, [b.id, reviewee], c);
      const now = new Date();
      const visibleAt = reviewVisibleAt({ submittedAt: now, counterpartReviewedAt: counterpart ? new Date(counterpart.created_at) : null, jobCompletedAt: new Date(b.job_completed_at) }, timing);
      const review = await this.db.one(
        `INSERT INTO reviews (booking_id, category_id, reviewer_user_id, reviewee_user_id, reviewer_role, rating, comment, comment_original, category_breakdown, moderation_flags, is_hidden, visible_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [b.id, b.category_id, a.userId, reviewee, role, d.rating, mod?.text ?? null, mod?.redacted ? d.comment : null, JSON.stringify(breakdown),
         mod?.reasons ?? [], !!mod?.flagged, visibleAt], c);
      if (counterpart) await c.query(`UPDATE reviews SET visible_at = LEAST(visible_at, $2) WHERE id = $1`, [counterpart.id, visibleAt]);
      if (visibleAt <= now) await this.refreshAggregates(c, [b.provider_id], [b.customer_id]);
      await this.outbox.emit(c, Events.ReviewPublished, 'booking', b.id, { bookingId: b.id, revieweeId: reviewee, rating: d.rating, visibleAt });
      return { ...review, flaggedForModeration: !!mod?.flagged };
    });
  }

  async refreshAggregates(c: Queryable, providerIds: string[], customerIds: string[]) {
    for (const p of new Set(providerIds)) await c.query(`SELECT refresh_provider_rating($1)`, [p]);
    for (const cu of new Set(customerIds)) {
      await c.query(
        `UPDATE customers SET rating_avg = s.avg, rating_count = s.cnt FROM (
           SELECT ROUND(AVG(rating)::numeric, 2) AS avg, COUNT(*)::int AS cnt FROM reviews
            WHERE reviewee_user_id = $1 AND reviewer_role = 'provider' AND NOT is_hidden AND visible_at <= clock_timestamp()) s WHERE id = $1`, [cu]);
    }
  }

  /** Scheduler: reviews whose double-blind window just elapsed now count toward ratings. */
  async releaseDue(sinceMinutes = 10): Promise<number> {
    const rows = await this.db.many(
      `SELECT DISTINCT reviewee_user_id, reviewer_role FROM reviews WHERE visible_at <= now() AND visible_at > now() - make_interval(mins => $1)`, [sinceMinutes]);
    await this.refreshAggregates(this.db.pool,
      rows.filter(r => r.reviewer_role === 'customer').map(r => r.reviewee_user_id),
      rows.filter(r => r.reviewer_role === 'provider').map(r => r.reviewee_user_id));
    return rows.length;
  }

  forUser(userId: string, limit = 30) {
    return this.db.many(
      `SELECT r.id, r.rating, r.comment, r.category_breakdown, r.reviewer_role, r.created_at, split_part(u.full_name,' ',1) AS reviewer_first_name, c.name AS category_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_user_id JOIN service_categories c ON c.id = r.category_id
        WHERE r.reviewee_user_id = $1 AND NOT r.is_hidden AND r.visible_at <= now() ORDER BY r.created_at DESC LIMIT $2`, [userId, Math.min(limit, 100)]);
  }

  /** Admin takedown (audit-logged; reviews are otherwise immutable). */
  async hide(a: Actor, id: string, reason: string, hidden = true) {
    return this.db.tx(async c => {
      const before = await this.db.oneOrFail(`SELECT * FROM reviews WHERE id = $1 FOR UPDATE`, [id], c, 'Review');
      const r = await this.db.one(`UPDATE reviews SET is_hidden = $2, hidden_by = $3, hidden_reason = $4 WHERE id = $1 RETURNING *`, [id, hidden, a.userId, reason], c);
      await this.audit.log(c, a, hidden ? 'review.hide' : 'review.unhide', 'review', id, { is_hidden: before.is_hidden }, { is_hidden: hidden }, reason);
      await this.refreshAggregates(c, before.reviewer_role === 'customer' ? [before.reviewee_user_id] : [], before.reviewer_role === 'provider' ? [before.reviewee_user_id] : []);
      return r;
    });
  }

  flagged() {
    return this.db.many(`SELECT r.*, u.full_name AS reviewer_name FROM reviews r JOIN users u ON u.id = r.reviewer_user_id
                          WHERE cardinality(r.moderation_flags) > 0 OR r.is_hidden ORDER BY r.created_at DESC LIMIT 200`);
  }
}
