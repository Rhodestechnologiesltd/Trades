import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DbService } from '../../common/db.service';
import { BookingsService } from '../bookings/bookings.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { DisputesService } from '../disputes/disputes.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PayoutsService } from '../payouts/payouts.service';
import { QuotesService } from '../quotes/quotes.service';
import { RecurringService } from '../recurring/recurring.service';
import { ReviewsService } from '../reviews/reviews.service';

interface Job { name: string; everyMs: number; run: () => Promise<number | void>; lockKey: number }

/**
 * Background job scheduler (§B.2) — the "system" actor.
 *
 * Durability comes from the data, not the timer: every time-based transition is a
 * row with a due timestamp (payout eligible_at, quote valid_until, auto_approve_at,
 * next_dispatch_check_at, …) that a sweep picks up with an idempotent, state-guarded
 * query. A crashed worker loses nothing; the next tick (on any worker) catches up.
 * Each job takes a Postgres advisory lock so only one worker runs it at a time.
 * Runs only in the worker process (WORKER=true). Temporal is the documented upgrade
 * path once workflows need richer visibility (§M).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Scheduler');
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly db: DbService,
    private readonly dispatch: DispatchService,
    private readonly quotes: QuotesService,
    private readonly bookings: BookingsService,
    private readonly payouts: PayoutsService,
    private readonly payments: PaymentsService,
    private readonly disputes: DisputesService,
    private readonly recurring: RecurringService,
    private readonly reviews: ReviewsService,
    private readonly notifications: NotificationsService,
  ) {}

  readonly jobs: Job[] = [
    { name: 'dispatch.sweep',            everyMs: 5_000,     lockKey: 7001, run: () => this.dispatch.sweep() },        // urgent SLA ~90s needs fine ticks
    { name: 'notifications.deliver',     everyMs: 2_000,     lockKey: 7002, run: () => this.notifications.deliverDue() },
    { name: 'quotes.expire',             everyMs: 30_000,    lockKey: 7003, run: () => this.quotes.expireDue() },
    { name: 'bookings.paymentWindow',    everyMs: 30_000,    lockKey: 7004, run: () => this.bookings.expireUnpaid() },
    { name: 'bookings.autoApprove',      everyMs: 60_000,    lockKey: 7005, run: () => this.bookings.autoApproveDue() },
    { name: 'bookings.noShow',           everyMs: 60_000,    lockKey: 7006, run: () => this.bookings.detectNoShows() },
    { name: 'payouts.release',           everyMs: 60_000,    lockKey: 7007, run: () => this.payouts.releaseDue() },
    { name: 'payouts.reconcile',         everyMs: 5 * 60_000, lockKey: 7008, run: () => this.payouts.reconcileStale() },
    { name: 'refunds.retry',             everyMs: 2 * 60_000, lockKey: 7009, run: () => this.payments.retryPendingRefunds() },
    { name: 'disputes.sweep',            everyMs: 5 * 60_000, lockKey: 7010, run: () => this.disputes.sweep() },
    { name: 'recurring.generate',        everyMs: 10 * 60_000, lockKey: 7011, run: () => this.recurring.generateDue() },
    { name: 'reviews.release',           everyMs: 5 * 60_000, lockKey: 7012, run: () => this.reviews.releaseDue(10) },
    { name: 'fraud.sweep',               everyMs: 60 * 60_000, lockKey: 7013, run: () => this.fraudSweep() },
    { name: 'compliance.licenceExpiry',  everyMs: 6 * 3600_000, lockKey: 7014, run: () => this.licenceExpiry() },
    { name: 'retention.purge',           everyMs: 6 * 3600_000, lockKey: 7015, run: () => this.retentionPurge() },
  ];

  onApplicationBootstrap() {
    if (process.env.WORKER !== 'true') return;
    for (const job of this.jobs) {
      this.timers.push(setInterval(() => void this.tick(job), job.everyMs));
      setTimeout(() => void this.tick(job), 1000 + Math.random() * 2000);
    }
    this.log.log(`Scheduler started with ${this.jobs.length} jobs`);
  }

  onModuleDestroy() { this.timers.forEach(clearInterval); }

  async tick(job: Job) {
    if (this.running.has(job.name)) return;
    this.running.add(job.name);
    const client = await this.db.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [job.lockKey]);
      if (!rows[0].ok) return;
      try {
        const started = Date.now();
        const n = await job.run();
        if (n) this.log.debug(`${job.name}: ${n} item(s) in ${Date.now() - started}ms`);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [job.lockKey]);
      }
    } catch (e: any) {
      this.log.error(`${job.name} failed: ${e.message}`);
    } finally {
      client.release();
      this.running.delete(job.name);
    }
  }

  /** Quote spam & chargeback-rate monitoring (§J). */
  async fraudSweep(): Promise<number> {
    const spam = await this.db.many(
      `INSERT INTO fraud_signals (subject_user_id, signal, severity, details)
       SELECT p.id, 'quote_spam', 2, json_build_object('submitted', p.quotes_submitted, 'accepted', p.quotes_accepted)
         FROM providers p WHERE p.quotes_submitted >= 40 AND p.quotes_accepted::numeric / p.quotes_submitted < 0.02
          AND NOT EXISTS (SELECT 1 FROM fraud_signals f WHERE f.subject_user_id = p.id AND f.signal = 'quote_spam' AND f.created_at > now() - interval '7 days')
       RETURNING id`);
    const cb = await this.db.many(
      `INSERT INTO fraud_signals (subject_user_id, signal, severity, details)
       SELECT c.id, 'chargeback_rate', 4, json_build_object('chargebacks', c.chargeback_count)
         FROM customers c WHERE c.chargeback_count >= 2
          AND NOT EXISTS (SELECT 1 FROM fraud_signals f WHERE f.subject_user_id = c.id AND f.signal = 'chargeback_rate' AND f.created_at > now() - interval '30 days')
       RETURNING id`);
    return spam.length + cb.length;
  }

  /** Expired licences remove the provider from licence-gated categories until re-verified (§J). */
  async licenceExpiry(): Promise<number> {
    const rows = await this.db.many(
      `UPDATE provider_documents SET status = 'expired' WHERE kind = 'license' AND status = 'approved' AND expires_at < current_date RETURNING provider_id, category_id`);
    for (const r of rows) {
      if (r.category_id) await this.db.pool.query(`UPDATE provider_service_categories SET approved = false WHERE provider_id = $1 AND category_id = $2`, [r.provider_id, r.category_id]);
    }
    return rows.length;
  }

  /** Data minimisation (§G.7): raw pings 30 days; ephemeral auth/idempotency data shorter. */
  async retentionPurge(): Promise<number> {
    const a = await this.db.pool.query(`DELETE FROM provider_location_pings WHERE received_at < now() - interval '30 days'`);
    const b = await this.db.pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
    const c = await this.db.pool.query(`DELETE FROM otp_challenges WHERE created_at < now() - interval '2 days'`);
    const d = await this.db.pool.query(`DELETE FROM outbox_events WHERE published_at < now() - interval '14 days'`);
    return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0) + (d.rowCount ?? 0);
  }
}
