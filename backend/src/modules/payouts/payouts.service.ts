import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BookingMachine, PayoutMachine, Settlement, breakdownFromFrozen, clawbackRecoveryFor, clawbackWriteOffJournal, money,
  payoutEligibleAt, payoutReleasedJournal, sub, toMajorString,
} from '@trades/domain';
import { Actor, SYSTEM_ACTOR } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { decrypt } from '../../common/crypto';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';
import { StateService } from '../../common/state.service';
import { LedgerService } from '../ledger/ledger.service';
import { DISBURSEMENT_RAIL, DisbursementRail } from '../payments/gateway';

const MAX_DISBURSE_ATTEMPTS = 5;

/**
 * Payout lifecycle (§C.8) and double-payout prevention (§F.4):
 *  - one payout_records row per booking (UNIQUE booking_id)
 *  - claim via claim_due_payouts() = FOR UPDATE SKIP LOCKED + 'processing' in one statement
 *  - the rail is called only after the claim commits, with the payout's idempotency key
 *  - 'processing' rows are reconciled by idempotency-key lookup, never blindly re-sent
 */
@Injectable()
export class PayoutsService {
  private readonly log = new Logger('Payouts');

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cfg: PlatformConfigService,
    @Inject(DISBURSEMENT_RAIL) private readonly rail: DisbursementRail,
  ) {}

  private async frozenBreakdown(q: Queryable, bookingId: string) {
    const b = await this.db.oneOrFail(
      `SELECT b.agreed_amount, b.currency_code, f.fee_bps, c.commission_bps FROM bookings b
         JOIN platform_fees f ON f.booking_id = b.id JOIN platform_commissions c ON c.booking_id = b.id WHERE b.id = $1`, [bookingId], q, 'Booking');
    return breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code, b.fee_bps, b.commission_bps);
  }

  /** approved_by_customer → payout_pending, eligible at approval + 48h. */
  async schedule(q: Queryable, bookingId: string, approvedAt: Date) {
    const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1`, [bookingId], q, 'Booking');
    const fb = await this.frozenBreakdown(q, bookingId);
    const timing = await this.cfg.timing();
    const eligibleAt = payoutEligibleAt(approvedAt, timing);
    const acct = await this.db.one(`SELECT payout_account_id FROM providers WHERE id = $1`, [b.provider_id], q);
    await q.query(
      `INSERT INTO payout_records (booking_id, provider_id, payout_account_id, gross_amount, commission_deducted, net_payout_amount, currency_code, eligible_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (booking_id) DO NOTHING`,
      [b.id, b.provider_id, acct?.payout_account_id ?? null, n(fb.agreed), n(fb.providerCommission), n(fb.providerNet), b.currency_code, eligibleAt, `payout:${b.id}`]);
    const payout = await this.db.one(`SELECT id FROM payout_records WHERE booking_id = $1`, [b.id], q);
    await this.state.created(q, 'payout', payout!.id, 'payout_pending', SYSTEM_ACTOR, { eligibleAt });
    await this.state.transition(q, BookingMachine, b.id, 'schedule_payout', SYSTEM_ACTOR);
    await this.outbox.emit(q, Events.PayoutScheduled, 'booking', b.id,
      { bookingId: b.id, providerId: b.provider_id, reference: b.reference, net: n(fb.providerNet), currency: b.currency_code, eligibleAt }, b.market_id);
    return { eligibleAt, net: fb.providerNet };
  }

  /**
   * After a dispute/cancellation settlement: shrink (or create) the payout to the
   * provider's adjusted net. A zero net cancels the payout.
   */
  async applySettlement(q: Queryable, bookingId: string, s: Settlement, opts: { eligibleNow: boolean }) {
    const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1`, [bookingId], q, 'Booking');
    const existing = await this.db.one(`SELECT * FROM payout_records WHERE booking_id = $1 FOR UPDATE`, [bookingId], q);
    if (existing && !['payout_pending', 'held'].includes(existing.status)) {
      throw new ConflictError(`Payout is already ${existing.status}; use the clawback flow`, 'payout_not_adjustable');
    }
    if (s.providerNetAfter.minor === 0) {
      if (existing) await this.state.transition(q, PayoutMachine, existing.id, 'cancel', SYSTEM_ACTOR, { metadata: { reason: 'settlement' } });
      return null;
    }
    const adj = s.adjusted!;
    const eligibleAt = opts.eligibleNow ? new Date() : payoutEligibleAt(new Date(), await this.cfg.timing());
    if (existing) {
      if (existing.status === 'held') await this.state.transition(q, PayoutMachine, existing.id, 'unhold', { userId: null, type: 'finance' });
      await q.query(
        `UPDATE payout_records SET gross_amount = $2, commission_deducted = $3, net_payout_amount = $4, dispute_flag = false, hold_reason = NULL,
                eligible_at = GREATEST(eligible_at, $5) WHERE id = $1`,
        [existing.id, n(adj.agreed), n(adj.providerCommission), n(adj.providerNet), eligibleAt]);
      return existing.id;
    }
    const acct = await this.db.one(`SELECT payout_account_id FROM providers WHERE id = $1`, [b.provider_id], q);
    const row = await this.db.one(
      `INSERT INTO payout_records (booking_id, provider_id, payout_account_id, gross_amount, commission_deducted, net_payout_amount, currency_code, eligible_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.id, b.provider_id, acct?.payout_account_id ?? null, n(adj.agreed), n(adj.providerCommission), n(adj.providerNet), b.currency_code, eligibleAt, `payout:${b.id}`], q);
    await this.state.created(q, 'payout', row!.id, 'payout_pending', SYSTEM_ACTOR, { settlement: true });
    return row!.id;
  }

  async setDisputeFlag(q: Queryable, bookingId: string, flag: boolean, reason?: string) {
    const p = await this.db.one(`SELECT * FROM payout_records WHERE booking_id = $1 FOR UPDATE`, [bookingId], q);
    if (!p) return null;
    await q.query(`UPDATE payout_records SET dispute_flag = $2 WHERE id = $1`, [p.id, flag]);
    if (flag && p.status === 'payout_pending') {
      await this.state.transition(q, PayoutMachine, p.id, 'hold', SYSTEM_ACTOR, { set: { hold_reason: reason ?? 'dispute' } });
    }
    return p;
  }

  /* ───────────── release ───────────── */

  async releaseDue(limit = 50): Promise<number> {
    const claimed = await this.db.many(`SELECT * FROM claim_due_payouts($1)`, [limit]);
    for (const p of claimed) {
      await this.db.pool.query(
        `INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type) VALUES ('payout',$1,'payout_pending','processing','claim','system')`, [p.id]);
      await this.disburse(p).catch(e => this.log.error(`payout ${p.id}: ${e.message}`));
    }
    return claimed.length;
  }

  private async disburse(p: any) {
    // 1) Fix the clawback recovery amount BEFORE calling the rail so retries send the same amount.
    const { toSend } = await this.db.tx(async c => {
      const row = await this.db.one(`SELECT * FROM payout_records WHERE id = $1 FOR UPDATE`, [p.id], c);
      if (row!.status !== 'processing') return { toSend: null, recovered: null };
      const net = m(row!.net_payout_amount, row!.currency_code);
      let rec = m(row!.clawback_recovered, row!.currency_code);
      if (row!.attempts === 1 && rec.minor === 0) {
        const out = await this.db.one(
          `SELECT COALESCE(SUM(amount - recovered_amount), 0) AS outstanding FROM provider_clawbacks
            WHERE provider_id = $1 AND currency_code = $2 AND status IN ('open','recovering')`, [row!.provider_id, row!.currency_code], c);
        rec = clawbackRecoveryFor(net, m(out!.outstanding, row!.currency_code).minor, await this.cfg.abuse());
        if (rec.minor > 0) await c.query(`UPDATE payout_records SET clawback_recovered = $2 WHERE id = $1`, [p.id, n(rec)]);
      }
      return { toSend: sub(net, rec), recovered: rec };
    });
    if (!toSend) return;

    if (toSend.minor === 0) return this.finalizeReleased(p.id, 'clawback_offset', SYSTEM_ACTOR);

    const acct = await this.db.one(`SELECT * FROM payout_accounts WHERE id = $1`, [p.payout_account_id]);
    const details = JSON.parse(decrypt(acct.account_details_encrypted));
    const result = await this.rail.disburse({
      idempotencyKey: p.idempotency_key, amount: toMajorString(toSend), currency: p.currency_code, reference: `TRADES ${p.booking_id.slice(0, 8)}`,
      account: { method: acct.method, holderName: acct.account_holder_name, details },
    }).catch((e: any) => ({ status: 'failed' as const, error: e.message }));

    if (result.status === 'succeeded') return this.finalizeReleased(p.id, result.reference ?? null, SYSTEM_ACTOR);
    if (result.status === 'pending') {
      await this.db.pool.query(`UPDATE payout_records SET disbursement_reference = COALESCE($2, disbursement_reference) WHERE id = $1`, [p.id, result.reference ?? null]);
      return;
    }
    await this.db.tx(async c => {
      const backoffMin = Math.min(24 * 60, 15 * 2 ** p.attempts);
      await this.state.transition(c, PayoutMachine, p.id, 'disbursement_failed', SYSTEM_ACTOR, {
        set: { last_error: result.error ?? 'unknown', eligible_at: new Date(Date.now() + backoffMin * 60_000), processing_started_at: null },
      });
      if (p.attempts >= MAX_DISBURSE_ATTEMPTS) {
        await this.state.transition(c, PayoutMachine, p.id, 'hold', SYSTEM_ACTOR, { set: { hold_reason: `disbursement failed ${p.attempts}×: ${result.error}` } });
        const b = await this.db.one(`SELECT reference, provider_id, market_id FROM bookings WHERE id = $1`, [p.booking_id], c);
        await this.outbox.emit(c, Events.PayoutHeld, 'booking', p.booking_id, { bookingId: p.booking_id, providerId: b!.provider_id, reference: b!.reference, reason: 'we could not reach your bank account — please check your payout details' }, b!.market_id);
      }
    });
  }

  /** Idempotent: only a 'processing' payout can be finalised, and the journal key is unique. */
  async finalizeReleased(payoutId: string, reference: string | null, actor: Actor) {
    await this.db.tx(async c => {
      const p = await this.db.one(`SELECT * FROM payout_records WHERE id = $1 FOR UPDATE`, [payoutId], c);
      if (!p || p.status !== 'processing') return;
      await this.state.transition(c, PayoutMachine, p.id, 'disbursed', SYSTEM_ACTOR, { set: { released_at: new Date(), disbursement_reference: reference } });
      const net = m(p.net_payout_amount, p.currency_code);
      const rec = m(p.clawback_recovered, p.currency_code);
      await this.ledger.post(c, payoutReleasedJournal(net, rec), {
        idempotencyKey: `payout_released:${p.id}`, actor, bookingId: p.booking_id, providerId: p.provider_id, referenceId: p.id, referenceType: 'payout',
      });
      if (rec.minor > 0) await this.applyClawbackRecovery(c, p.provider_id, p.currency_code, rec.minor);
      await c.query(`UPDATE payment_holds SET hold_status = 'released_to_payout', released_at = now() WHERE booking_id = $1 AND hold_status IN ('active','partially_released')`, [p.booking_id]);
      const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [p.booking_id], c);
      if (b!.status === 'payout_pending') await this.state.transition(c, BookingMachine, b!.id, 'release_payout', actor);
      await this.outbox.emit(c, Events.PayoutReleased, 'booking', b!.id,
        { bookingId: b!.id, providerId: p.provider_id, reference: b!.reference, net: toMajorString(sub(net, rec)), recovered: toMajorString(rec), currency: p.currency_code }, b!.market_id);
    });
  }

  private async applyClawbackRecovery(c: Queryable, providerId: string, currency: string, amountMinor: number) {
    let remaining = amountMinor;
    const open = await this.db.many(
      `SELECT * FROM provider_clawbacks WHERE provider_id = $1 AND currency_code = $2 AND status IN ('open','recovering') ORDER BY created_at FOR UPDATE`, [providerId, currency], c);
    for (const cb of open) {
      if (remaining <= 0) break;
      const owed = m(cb.amount, currency).minor - m(cb.recovered_amount, currency).minor;
      const take = Math.min(owed, remaining);
      remaining -= take;
      const newRecovered = m(cb.recovered_amount, currency).minor + take;
      await c.query(`UPDATE provider_clawbacks SET recovered_amount = $2, status = $3 WHERE id = $1`,
        [cb.id, toMajorString(money(newRecovered, currency)), newRecovered >= m(cb.amount, currency).minor ? 'recovered' : 'recovering']);
    }
  }

  /** Reconciliation sweep for payouts stuck in 'processing' (crash between claim and confirmation). */
  async reconcileStale(): Promise<number> {
    const stale = await this.db.many(`SELECT * FROM stale_processing_payouts('15 minutes')`);
    for (const p of stale) {
      const st = await this.rail.status(p.idempotency_key).catch(() => null);
      if (st?.status === 'succeeded') await this.finalizeReleased(p.id, st.reference ?? null, SYSTEM_ACTOR);
      else if (st?.status === 'failed') {
        await this.db.tx(c => this.state.transition(c, PayoutMachine, p.id, 'disbursement_failed', SYSTEM_ACTOR, { set: { last_error: st.error ?? 'failed', processing_started_at: null } }));
      } else if (st === null && this.rail.name === 'sandbox') {
        // Sandbox lost its memory (restart) and never sent it: safe to retry with the same idempotency key.
        await this.disburse(p);
      }
      // status unknown on a real rail → leave for Finance (alerted via ops dashboard)
    }
    return stale.length;
  }

  /* ───────────── finance / admin actions ───────────── */

  async manualRelease(actor: Actor, bookingId: string, reason: string) {
    if (!reason?.trim()) throw new ValidationError('A reason is required');
    const p = await this.db.tx(async c => {
      const open = await this.db.one(`SELECT 1 FROM disputes WHERE booking_id = $1 AND status IN ('opened','under_review','awaiting_evidence')`, [bookingId], c);
      if (open) throw new ConflictError('Resolve the open dispute before releasing this payout');
      const row = await this.db.one(
        `UPDATE payout_records SET status = 'processing', processing_started_at = now(), attempts = attempts + 1, eligible_at = LEAST(eligible_at, now())
          WHERE booking_id = $1 AND status = 'payout_pending' AND dispute_flag = false AND payout_account_id IS NOT NULL RETURNING *`, [bookingId], c);
      if (!row) throw new ConflictError('No releasable payout for this booking (check status, dispute flag and payout account)');
      await c.query(`INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, actor_user_id, metadata)
                     VALUES ('payout',$1,'payout_pending','processing','claim',$2,$3,$4)`, [row.id, actor.type, actor.userId, JSON.stringify({ manual: true, reason })]);
      await this.audit.log(c, actor, 'payout.manual_release', 'payout', row.id, null, { bookingId }, reason);
      return row;
    });
    await this.disburse(p);
    return this.db.one(`SELECT * FROM payout_records WHERE id = $1`, [p.id]);
  }

  async hold(actor: Actor, bookingId: string, reason: string) {
    return this.db.tx(async c => {
      const p = await this.db.one(`SELECT id FROM payout_records WHERE booking_id = $1`, [bookingId], c);
      if (!p) throw new NotFoundError('Payout not found');
      const r = await this.state.transition(c, PayoutMachine, p.id, 'hold', actor, { set: { hold_reason: reason } });
      await this.audit.log(c, actor, 'payout.hold', 'payout', p.id, null, null, reason);
      return r.row;
    });
  }

  async unhold(actor: Actor, bookingId: string, reason: string) {
    return this.db.tx(async c => {
      const p = await this.db.one(`SELECT id, dispute_flag FROM payout_records WHERE booking_id = $1`, [bookingId], c);
      if (!p) throw new NotFoundError('Payout not found');
      if (p.dispute_flag) throw new ConflictError('Payout is held by an open dispute');
      const r = await this.state.transition(c, PayoutMachine, p.id, 'unhold', actor, { set: { hold_reason: null } });
      await this.audit.log(c, actor, 'payout.unhold', 'payout', p.id, null, null, reason);
      return r.row;
    });
  }

  /** Finance confirms a manual bank-file batch was paid by the bank. */
  async confirmManual(actor: Actor, payoutIds: string[], bankReference: string) {
    for (const id of payoutIds) await this.finalizeReleased(id, bankReference, actor);
    await this.audit.log(this.db.pool, actor, 'payout.confirm_manual', 'payout_batch', null, null, { payoutIds, bankReference });
    return { confirmed: payoutIds.length };
  }

  /** Exports processing payouts awaiting a manual rail as a bank bulk-transfer CSV (logs sensitive access). */
  async exportBatch(actor: Actor, marketId: string) {
    return this.db.tx(async c => {
      const rows = await this.db.many(
        `SELECT pr.*, a.account_holder_name, a.account_details_encrypted, a.bank_name, b.reference FROM payout_records pr
           JOIN payout_accounts a ON a.id = pr.payout_account_id JOIN bookings b ON b.id = pr.booking_id
          WHERE pr.status = 'processing' AND pr.batch_id IS NULL AND b.market_id = $1 ORDER BY pr.processing_started_at FOR UPDATE OF pr`, [marketId], c);
      if (!rows.length) return { batch: null, csv: '' };
      const total = rows.reduce((s, r) => s + m(r.net_payout_amount, r.currency_code).minor - m(r.clawback_recovered, r.currency_code).minor, 0);
      const batch = await this.db.one(
        `INSERT INTO payout_batches (market_id, currency_code, total_amount, payout_count, status, approved_by, approved_at) VALUES ($1,$2,$3,$4,'exported',$5,now()) RETURNING *`,
        [marketId, rows[0].currency_code, toMajorString(money(total, rows[0].currency_code)), rows.length, actor.userId], c);
      await c.query(`UPDATE payout_records SET batch_id = $2 WHERE id = ANY($1)`, [rows.map(r => r.id), batch!.id]);
      const csv = ['payout_id,beneficiary,bank,account_number,bank_code,amount,currency,reference'];
      for (const r of rows) {
        const d = JSON.parse(decrypt(r.account_details_encrypted));
        const amt = toMajorString(sub(m(r.net_payout_amount, r.currency_code), m(r.clawback_recovered, r.currency_code)));
        csv.push([r.id, JSON.stringify(r.account_holder_name), JSON.stringify(r.bank_name ?? ''), d.accountNumber, d.bankCode ?? '', amt, r.currency_code, r.reference].join(','));
        await this.audit.sensitiveRead(c, actor, 'payout_account', r.provider_id, r.payout_account_id, 'bank_batch_export');
      }
      await this.audit.log(c, actor, 'payout.batch_export', 'payout_batch', batch!.id, null, { count: rows.length });
      return { batch, csv: csv.join('\n') };
    });
  }

  async writeOffClawback(actor: Actor, clawbackId: string, reason: string) {
    return this.db.tx(async c => {
      const cb = await this.db.oneOrFail(`SELECT * FROM provider_clawbacks WHERE id = $1 FOR UPDATE`, [clawbackId], c, 'Clawback');
      if (!['open', 'recovering', 'appealed'].includes(cb.status)) throw new ConflictError('Clawback is not outstanding');
      const outstanding = m(cb.amount, cb.currency_code).minor - m(cb.recovered_amount, cb.currency_code).minor;
      await this.ledger.post(c, clawbackWriteOffJournal(money(outstanding, cb.currency_code)), {
        idempotencyKey: `clawback_write_off:${cb.id}`, actor, bookingId: cb.booking_id, providerId: cb.provider_id, referenceId: cb.id, referenceType: 'clawback',
      });
      await c.query(`UPDATE provider_clawbacks SET status = 'written_off' WHERE id = $1`, [cb.id]);
      await this.audit.log(c, actor, 'clawback.write_off', 'provider_clawback', cb.id, cb, null, reason);
      return { ok: true };
    });
  }

  list(filter: { status?: string; providerId?: string; limit?: number }) {
    return this.db.many(
      `SELECT pr.*, b.reference, u.full_name AS provider_name, a.account_last4, a.payouts_allowed_after
         FROM payout_records pr JOIN bookings b ON b.id = pr.booking_id JOIN users u ON u.id = pr.provider_id
         LEFT JOIN payout_accounts a ON a.id = pr.payout_account_id
        WHERE ($1::text IS NULL OR pr.status::text = $1) AND ($2::uuid IS NULL OR pr.provider_id = $2)
        ORDER BY pr.eligible_at DESC LIMIT $3`, [filter.status ?? null, filter.providerId ?? null, Math.min(filter.limit ?? 200, 1000)]);
  }
}
