import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { PaymentMachine, goodwillRefundJournal } from '@trades/domain';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { encrypt } from '../../common/crypto';
import { DbService } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';
import { StateService } from '../../common/state.service';
import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly cfg: PlatformConfigService,
    private readonly media: MediaService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentsService,
    private readonly state: StateService,
  ) {}

  /* ───────────── dashboard & analytics ───────────── */

  async dashboard(marketId?: string) {
    const p = [marketId ?? null];
    const [kpi, byStatus, revenue, queues, topCategories, daily] = await Promise.all([
      this.db.one(
        `SELECT (SELECT count(*)::int FROM service_requests WHERE created_at > now() - interval '24 hours' AND ($1::uuid IS NULL OR market_id = $1)) AS requests_24h,
                (SELECT count(*)::int FROM bookings WHERE created_at > now() - interval '24 hours' AND ($1::uuid IS NULL OR market_id = $1)) AS bookings_24h,
                (SELECT COALESCE(sum(agreed_amount),0) FROM bookings WHERE status NOT IN ('payment_pending','cancelled') AND created_at > now() - interval '30 days' AND ($1::uuid IS NULL OR market_id = $1)) AS gmv_30d,
                (SELECT count(*)::int FROM providers p JOIN users u ON u.id = p.id WHERE p.availability_status = 'online' AND ($1::uuid IS NULL OR u.market_id = $1)) AS providers_online,
                (SELECT round(100.0 * count(*) FILTER (WHERE status = 'accepted') / NULLIF(count(*) FILTER (WHERE status IN ('accepted','expired','cancelled')),0), 1)
                   FROM service_requests WHERE created_at > now() - interval '30 days' AND ($1::uuid IS NULL OR market_id = $1)) AS fulfilment_rate_pct,
                (SELECT round(avg(extract(epoch FROM (q.created_at - r.created_at)))::numeric / 60, 1) FROM quotes q JOIN service_requests r ON r.id = q.service_request_id
                   WHERE q.created_at > now() - interval '7 days' AND r.request_mode = 'urgent') AS urgent_first_quote_min`, p),
      this.db.many(`SELECT status, count(*)::int AS n FROM bookings WHERE ($1::uuid IS NULL OR market_id = $1) GROUP BY status ORDER BY status`, p),
      this.ledger.trialBalance(),
      this.db.one(
        `SELECT (SELECT count(*)::int FROM providers WHERE verification_status = 'pending') AS pending_verifications,
                (SELECT count(*)::int FROM disputes WHERE status IN ('opened','under_review','awaiting_evidence')) AS open_disputes,
                (SELECT count(*)::int FROM disputes WHERE status IN ('opened','under_review','awaiting_evidence') AND sla_due_at < now()) AS disputes_sla_breached,
                (SELECT count(*)::int FROM payout_records WHERE status = 'payout_pending' AND eligible_at <= now() + interval '24 hours') AS payouts_due_24h,
                (SELECT count(*)::int FROM payout_records WHERE status = 'held') AS payouts_held,
                (SELECT count(*)::int FROM payout_records WHERE status = 'processing' AND processing_started_at < now() - interval '1 hour') AS payouts_stuck,
                (SELECT count(*)::int FROM fraud_signals WHERE status = 'open') AS fraud_open,
                (SELECT count(*)::int FROM notifications WHERE status = 'failed' AND last_error <> 'no_push_tokens' AND created_at > now() - interval '24 hours') AS notifications_dead_24h,
                (SELECT count(*)::int FROM service_requests WHERE admin_assist_requested AND status IN ('expired','dispatched')) AS admin_assist,
                (SELECT count(*)::int FROM refunds WHERE status = 'initiated' AND rail = 'bank_transfer') AS manual_refunds,
                (SELECT count(*)::int FROM payment_webhook_events WHERE NOT signature_valid AND received_at > now() - interval '24 hours') AS invalid_webhooks_24h`),
      this.db.many(
        `SELECT c.name, count(*)::int AS requests, count(b.id)::int AS bookings FROM service_requests r JOIN service_categories c ON c.id = COALESCE((SELECT parent_id FROM service_categories WHERE id = r.category_id), r.category_id)
           LEFT JOIN bookings b ON b.service_request_id = r.id WHERE r.created_at > now() - interval '30 days' AND ($1::uuid IS NULL OR r.market_id = $1)
          GROUP BY c.name ORDER BY requests DESC LIMIT 12`, p),
      this.db.many(
        `SELECT d::date AS day,
                (SELECT count(*)::int FROM service_requests WHERE created_at::date = d::date AND ($1::uuid IS NULL OR market_id = $1)) AS requests,
                (SELECT count(*)::int FROM bookings WHERE created_at::date = d::date AND status NOT IN ('payment_pending','cancelled') AND ($1::uuid IS NULL OR market_id = $1)) AS paid_bookings,
                (SELECT COALESCE(sum(e.amount),0) FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id
                  WHERE e.account IN ('platform_fee_revenue','platform_commission_revenue') AND e.entry_type = 'credit' AND j.recorded_at::date = d::date) AS revenue
           FROM generate_series(now() - interval '13 days', now(), interval '1 day') d ORDER BY day`, p),
    ]);
    return { kpi, bookingsByStatus: byStatus, ledger: revenue, queues, topCategories, daily };
  }

  async analytics(kind: 'funnel' | 'category-demand' | 'provider-utilization' | 'heatmap', days = 30) {
    switch (kind) {
      case 'funnel':
        return this.db.one(
          `SELECT count(*)::int AS requests,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM provider_dispatches pd WHERE pd.service_request_id = r.id))::int AS dispatched,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM quotes q WHERE q.service_request_id = r.id))::int AS quoted,
                  count(*) FILTER (WHERE r.status = 'accepted')::int AS accepted,
                  count(b.id) FILTER (WHERE b.status NOT IN ('payment_pending','cancelled'))::int AS paid,
                  count(b.id) FILTER (WHERE b.status IN ('approved_by_customer','payout_pending','payout_released'))::int AS completed
             FROM service_requests r LEFT JOIN bookings b ON b.service_request_id = r.id WHERE r.created_at > now() - make_interval(days => $1)`, [days]);
      case 'category-demand':
        return this.db.many(
          `SELECT c.name, r.request_mode, count(*)::int AS requests, round(avg(q.amount),2) AS avg_quote,
                  round(100.0 * count(*) FILTER (WHERE r.status = 'expired') / count(*), 1) AS expired_pct
             FROM service_requests r JOIN service_categories c ON c.id = r.category_id LEFT JOIN quotes q ON q.service_request_id = r.id AND q.status = 'accepted'
            WHERE r.created_at > now() - make_interval(days => $1) GROUP BY c.name, r.request_mode ORDER BY requests DESC`, [days]);
      case 'provider-utilization':
        return this.db.many(
          `SELECT p.id, u.full_name, p.rating_avg, p.no_show_count, p.response_speed_avg_sec, p.quotes_submitted, p.quotes_accepted,
                  round(100.0 * p.quotes_accepted / NULLIF(p.quotes_submitted,0), 1) AS conversion_pct,
                  (SELECT count(*)::int FROM bookings b WHERE b.provider_id = p.id AND b.created_at > now() - make_interval(days => $1)) AS jobs
             FROM providers p JOIN users u ON u.id = p.id WHERE p.verification_status = 'verified' ORDER BY jobs DESC LIMIT 200`, [days]);
      case 'heatmap':
        return this.db.many(
          `SELECT round(l.approx_lat::numeric, 2) AS lat, round(l.approx_lng::numeric, 2) AS lng, count(*)::int AS requests,
                  count(*) FILTER (WHERE r.status = 'expired')::int AS unmet
             FROM service_requests r JOIN request_locations l ON l.service_request_id = r.id
            WHERE r.created_at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY requests DESC LIMIT 500`, [days]);
    }
  }

  /* ───────────── provider verification (§J KYC) ───────────── */

  verificationQueue(status = 'pending') {
    return this.db.many(
      `SELECT p.id, u.full_name, u.phone_number, u.email, p.business_name, p.verification_status, pp.background_check_status, u.created_at,
              ARRAY(SELECT sc.name FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id WHERE psc.provider_id = p.id) AS categories,
              (SELECT count(*)::int FROM provider_documents d WHERE d.provider_id = p.id AND d.status = 'uploaded') AS docs_to_review
         FROM providers p JOIN users u ON u.id = p.id JOIN provider_profiles pp ON pp.provider_id = p.id
        WHERE p.verification_status::text = $1 ORDER BY u.created_at LIMIT 200`, [status]);
  }

  async providerDetail(a: Actor, id: string) {
    const p = await this.db.one(
      `SELECT p.*, u.full_name, u.phone_number, u.email, u.status AS user_status, u.created_at AS registered_at, pp.*
         FROM providers p JOIN users u ON u.id = p.id JOIN provider_profiles pp ON pp.provider_id = p.id WHERE p.id = $1`, [id]);
    if (!p) throw new NotFoundError('Provider not found');
    const docs = await this.db.many(`SELECT * FROM provider_documents WHERE provider_id = $1 ORDER BY created_at DESC`, [id]);
    await this.audit.sensitiveRead(this.db.pool, a, 'kyc_document', id, null, 'verification_review');
    const documents = await Promise.all(docs.map(async d => ({ ...d, url: await this.media.signedGet(d.storage_key, 300).catch(() => null) })));
    const categories = await this.db.many(
      `SELECT psc.*, sc.name, sc.requires_license FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id WHERE psc.provider_id = $1`, [id]);
    const zones = await this.db.many(`SELECT id, zone_type, center_lat, center_lng, radius_meters, city FROM service_zones WHERE provider_id = $1`, [id]);
    const stats = await this.db.one(
      `SELECT count(*)::int AS bookings, count(*) FILTER (WHERE status = 'disputed')::int AS disputed,
              count(*) FILTER (WHERE cancelled_by = 'provider')::int AS provider_cancellations FROM bookings WHERE provider_id = $1`, [id]);
    const fraud = await this.db.many(`SELECT * FROM fraud_signals WHERE subject_user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return { ...p, documents, categories, zones, stats, fraudSignals: fraud };
  }

  async reviewDocument(a: Actor, docId: string, status: 'approved' | 'rejected', notes?: string) {
    return this.db.tx(async c => {
      const d = await this.db.oneOrFail(`UPDATE provider_documents SET status = $2, notes = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *`, [docId, status, notes ?? null, a.userId], c, 'Document');
      if (d.kind === 'license' && d.category_id) {
        await c.query(`UPDATE provider_service_categories SET approved = $3 WHERE provider_id = $1 AND category_id = $2`, [d.provider_id, d.category_id, status === 'approved']);
      }
      if (d.kind === 'background_check') {
        await c.query(`UPDATE provider_profiles SET background_check_status = $2 WHERE provider_id = $1`, [d.provider_id, status === 'approved' ? 'passed' : 'failed']);
      }
      await this.audit.log(c, a, 'provider.document.review', 'provider_document', docId, null, { status }, notes);
      return d;
    });
  }

  /** Support does initial review; only admins give final approval (§I). */
  async decideVerification(a: Actor, providerId: string, decision: 'approve' | 'reject', reason?: string) {
    if (decision === 'approve' && a.type !== 'admin') throw new ForbiddenError('Final approval requires an admin');
    if (decision === 'reject' && !reason) throw new ValidationError('A reason is required when rejecting');
    return this.db.tx(async c => {
      const p = await this.db.oneOrFail(`SELECT * FROM providers WHERE id = $1 FOR UPDATE`, [providerId], c, 'Provider');
      if (decision === 'approve') {
        const missing = await this.db.one(
          `SELECT
             (SELECT count(*) FROM provider_documents WHERE provider_id = $1 AND kind IN ('id_front','selfie') AND status = 'approved') < 2 AS id_missing,
             EXISTS (SELECT 1 FROM provider_service_categories psc JOIN service_categories sc ON sc.id = psc.category_id
                      JOIN provider_profiles pp ON pp.provider_id = psc.provider_id
                     WHERE psc.provider_id = $1 AND sc.requires_background_check AND pp.background_check_status <> 'passed') AS bg_missing`, [providerId], c);
        if (missing!.id_missing) throw new ConflictError('Approve the ID and selfie documents first');
        if (missing!.bg_missing) throw new ConflictError('A passed background check is required for this provider\'s categories');
      }
      await c.query(`UPDATE providers SET verification_status = $2 WHERE id = $1`, [providerId, decision === 'approve' ? 'verified' : 'rejected']);
      await c.query(`UPDATE users SET status = CASE WHEN $2 THEN 'active'::user_status ELSE status END WHERE id = $1`, [providerId, decision === 'approve']);
      if (decision === 'reject') await c.query(`UPDATE provider_profiles SET rejection_reason = $2 WHERE provider_id = $1`, [providerId, reason]);
      await this.audit.log(c, a, `provider.verification.${decision}`, 'provider', providerId, { verification_status: p.verification_status }, { decision }, reason);
      await this.outbox.emit(c, decision === 'approve' ? Events.ProviderVerified : Events.ProviderRejected, 'provider', providerId, { providerId, reason });
      return { verificationStatus: decision === 'approve' ? 'verified' : 'rejected' };
    });
  }

  /* ───────────── users ───────────── */

  searchUsers(q?: string, type?: string) {
    return this.db.many(
      `SELECT id, full_name, phone_number, email, user_type, status, created_at, last_login_at FROM users
        WHERE ($1::text IS NULL OR full_name ILIKE '%' || $1 || '%' OR phone_number LIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR user_type::text = $2) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`, [q || null, type || null]);
  }

  async setUserStatus(a: Actor, userId: string, status: 'active' | 'suspended' | 'banned', reason: string) {
    return this.db.tx(async c => {
      const u = await this.db.oneOrFail(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [userId], c, 'User');
      if (['admin', 'finance', 'support'].includes(u.user_type) && a.userId === userId) throw new ForbiddenError('You cannot change your own status');
      await c.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
      if (status !== 'active') {
        await c.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, `account_${status}`]);
        if (u.user_type === 'provider') await c.query(`UPDATE providers SET availability_status = 'offline' WHERE id = $1`, [userId]);
      }
      await this.audit.log(c, a, `user.${status}`, 'user', userId, { status: u.status }, { status }, reason);
      return { id: userId, status };
    });
  }

  async createStaff(a: Actor, d: { email: string; fullName: string; role: 'admin' | 'support' | 'finance'; password: string }) {
    const hash = await AuthService.hashPassword(d.password);
    const secret = authenticator.generateSecret();
    return this.db.tx(async c => {
      const u = await this.db.one(
        `INSERT INTO users (email, full_name, user_type, status, password_hash, mfa_secret_enc, mfa_enabled) VALUES ($1,$2,$3,'active',$4,$5,true) RETURNING id, email, user_type`,
        [d.email.toLowerCase(), d.fullName, d.role, hash, encrypt(secret).toString('base64')], c);
      await this.audit.log(c, a, 'staff.create', 'user', u!.id, null, { role: d.role, email: d.email });
      return { ...u, mfaProvisioningUri: authenticator.keyuri(d.email, 'Trades Admin', secret) };
    });
  }

  /* ───────────── bookings, requests, refunds ───────────── */

  bookings(filter: { status?: string; q?: string; limit?: number }) {
    return this.db.many(
      `SELECT b.id, b.reference, b.status, b.agreed_amount, b.currency_code, b.created_at, b.scheduled_start_at, c.name AS category,
              cu.full_name AS customer_name, pu.full_name AS provider_name
         FROM bookings b JOIN service_categories c ON c.id = b.category_id JOIN users cu ON cu.id = b.customer_id JOIN users pu ON pu.id = b.provider_id
        WHERE ($1::text IS NULL OR b.status::text = $1) AND ($2::text IS NULL OR b.reference ILIKE '%' || $2 || '%' OR cu.full_name ILIKE '%' || $2 || '%' OR pu.full_name ILIKE '%' || $2 || '%')
        ORDER BY b.created_at DESC LIMIT $3`, [filter.status || null, filter.q || null, Math.min(filter.limit ?? 100, 500)]);
  }

  requests(filter: { status?: string; adminAssist?: boolean }) {
    return this.db.many(
      `SELECT r.id, r.status, r.request_mode, r.title, r.created_at, r.current_search_radius_m, r.dispatch_wave, r.admin_assist_requested,
              c.name AS category, u.full_name AS customer_name, l.area_label,
              (SELECT count(*)::int FROM provider_dispatches pd WHERE pd.service_request_id = r.id) AS notified,
              (SELECT count(*)::int FROM quotes q WHERE q.service_request_id = r.id) AS quotes
         FROM service_requests r JOIN service_categories c ON c.id = r.category_id JOIN users u ON u.id = r.customer_id
         JOIN request_locations l ON l.service_request_id = r.id
        WHERE ($1::text IS NULL OR r.status::text = $1) AND (NOT $2 OR r.admin_assist_requested)
        ORDER BY r.created_at DESC LIMIT 200`, [filter.status || null, !!filter.adminAssist]);
  }

  refunds(status?: string) {
    return this.db.many(
      `SELECT r.*, b.reference FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE ($1::text IS NULL OR r.status::text = $1) ORDER BY r.created_at DESC LIMIT 200`, [status || null]);
  }

  /** Goodwill credit (§I): platform-funded, does not touch the provider's payout. Support is capped. */
  async goodwillRefund(a: Actor, bookingId: string, amount: string, reason: string) {
    if (!reason || reason.length < 10) throw new ValidationError('A reason (min 10 chars) is required');
    let refundId: string | null = null;
    await this.db.tx(async c => {
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId], c, 'Booking');
      const amt = m(amount, b.currency_code);
      if (amt.minor <= 0) throw new ValidationError('Amount must be positive');
      if (a.type === 'support') {
        const caps = await this.cfg.get<Record<string, number>>('support_goodwill_cap', {});
        if (amt.minor > (caps[b.currency_code] ?? 0)) throw new ForbiddenError('Amount exceeds your goodwill limit');
      }
      const p = await this.db.one(`SELECT * FROM payments WHERE booking_id = $1 AND status IN ('captured','partially_refunded') FOR UPDATE`, [b.id], c);
      if (!p) throw new ConflictError('No captured payment on this booking');
      if (amt.minor > m(p.amount_charged_to_customer, p.currency_code).minor - m(p.amount_refunded, p.currency_code).minor) throw new ValidationError('Amount exceeds refundable balance');
      const count = await this.db.one(`SELECT count(*)::int AS n FROM refunds WHERE booking_id = $1`, [b.id], c);
      const r = await this.db.one(
        `INSERT INTO refunds (booking_id, payment_id, amount, currency_code, adjusted_agreed_amount, reason, idempotency_key, initiated_by, initiated_by_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.id, p.id, n(amt), b.currency_code, b.agreed_amount, `Goodwill: ${reason}`, `refund:${b.id}:${p.id}:${count!.n + 1}`, a.userId, a.type], c);
      refundId = r!.id;
      await this.ledger.post(c, goodwillRefundJournal(amt), { idempotencyKey: `goodwill:${r!.id}`, actor: a, bookingId: b.id, referenceId: r!.id, referenceType: 'refund' });
      await this.state.transition(c, PaymentMachine, p.id, 'initiate_refund', a);
      await this.audit.log(c, a, 'refund.goodwill', 'refund', r!.id, null, { amount }, reason);
    });
    if (refundId) await this.payments.processRefund(refundId);
    return this.db.one(`SELECT * FROM refunds WHERE id = $1`, [refundId]);
  }

  async ingestChargeback(a: Actor, d: { paymentId?: string; gatewayReference?: string; amount?: string; reference: string; respondBy?: string; reason?: string }) {
    const p = await this.db.one(`SELECT id, gateway FROM payments WHERE id = $1 OR gateway_reference = $2 LIMIT 1`, [d.paymentId ?? null, d.gatewayReference ?? '']);
    if (!p) throw new NotFoundError('Payment not found');
    await this.payments.chargeback(p.gateway, {
      eventId: `manual:${d.reference}`, type: 'chargeback.opened', paymentId: p.id, gatewayReference: d.gatewayReference, amount: d.amount,
      chargebackReference: d.reference, chargebackRespondBy: d.respondBy, failureMessage: d.reason, raw: d,
    }, a);
    await this.audit.log(this.db.pool, a, 'chargeback.ingest', 'payment', p.id, null, d);
    return { ok: true };
  }

  /* ───────────── logs, fraud, notifications ───────────── */

  auditLogs(f: { entityType?: string; entityId?: string; actorId?: string; action?: string; limit?: number }, financialOnly = false) {
    return this.db.many(
      `SELECT a.*, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::uuid IS NULL OR a.entity_id = $2) AND ($3::uuid IS NULL OR a.actor_user_id = $3)
          AND ($4::text IS NULL OR a.action ILIKE $4 || '%')
          AND (NOT $6 OR a.entity_type IN ('payout','refund','payment','payout_batch','provider_clawback','platform_config','ledger'))
        ORDER BY a.id DESC LIMIT $5`,
      [f.entityType || null, f.entityId || null, f.actorId || null, f.action || null, Math.min(f.limit ?? 200, 1000), financialOnly]);
  }

  fraudSignals(status = 'open') {
    return this.db.many(
      `SELECT f.*, u.full_name, u.user_type FROM fraud_signals f JOIN users u ON u.id = f.subject_user_id
        WHERE f.status = $1 ORDER BY f.severity DESC, f.created_at DESC LIMIT 300`, [status]);
  }

  async updateFraudSignal(a: Actor, id: string, status: 'reviewing' | 'actioned' | 'dismissed', note?: string) {
    const r = await this.db.oneOrFail(`UPDATE fraud_signals SET status = $2, reviewed_by = $3 WHERE id = $1 RETURNING *`, [id, status, a.userId], undefined, 'Signal');
    await this.audit.log(this.db.pool, a, 'fraud_signal.update', 'fraud_signal', id, null, { status }, note);
    return r;
  }

  failedNotifications() {
    return this.db.many(`SELECT n.*, u.full_name FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE n.status = 'failed' AND n.last_error <> 'no_push_tokens' ORDER BY n.created_at DESC LIMIT 200`);
  }

  async retryNotification(id: string) {
    await this.db.pool.query(`UPDATE notifications SET status = 'queued', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND status = 'failed'`, [id]);
    return { ok: true };
  }
}
