import { Injectable } from '@nestjs/common';
import { Journal, LedgerAccount, toMajorString } from '@trades/domain';
import { Actor } from '../../common/auth';
import { DbService, Queryable } from '../../common/db.service';
import { ValidationError } from '../../common/errors';

const PROVIDER_SUBLEDGER: ReadonlySet<LedgerAccount> = new Set(['provider_payable', 'provider_clawback_receivable']);

/**
 * Append-only double-entry ledger (§B.2, §F.3). Journals are built by pure
 * functions in @trades/domain (balanced by construction) and re-checked by a
 * deferred DB trigger at COMMIT. One journal per idempotency key: replays of the
 * same webhook / job never double-post.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly db: DbService) {}

  /** Returns false when the journal was already posted (idempotent replay). */
  async post(q: Queryable, j: Journal, ctx: {
    idempotencyKey: string; actor: Actor; bookingId?: string | null; providerId?: string | null;
    referenceId?: string | null; referenceType?: string | null;
  }): Promise<boolean> {
    if (!j.lines.length) return false;
    const currency = j.lines[0].amount.currency;
    const header = await this.db.one(
      `INSERT INTO ledger_journals (kind, memo, booking_id, reference_id, reference_type, currency_code, idempotency_key, actor_type, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [j.kind, j.memo, ctx.bookingId ?? null, ctx.referenceId ?? null, ctx.referenceType ?? null, currency, ctx.idempotencyKey, ctx.actor.type, ctx.actor.userId], q);
    if (!header) return false;
    for (const l of j.lines) {
      await q.query(
        `INSERT INTO ledger_entries (journal_id, booking_id, provider_id, account, entry_type, amount, currency_code, reference_id, reference_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [header.id, ctx.bookingId ?? null, PROVIDER_SUBLEDGER.has(l.account) ? ctx.providerId ?? null : null, l.account, l.side,
         toMajorString(l.amount), l.amount.currency, ctx.referenceId ?? null, ctx.referenceType ?? null]);
    }
    return true;
  }

  trialBalance(currency?: string) {
    return this.db.many(`SELECT account, currency_code, balance FROM ledger_account_balances WHERE ($1::text IS NULL OR currency_code = $1) ORDER BY currency_code, account`, [currency ?? null]);
  }

  providerBalance(providerId: string) {
    return this.db.many(`SELECT currency_code, payable, clawback_owed FROM provider_balances WHERE provider_id = $1`, [providerId]);
  }

  async journals(opts: { bookingId?: string; kind?: string; from?: string; to?: string; limit?: number }) {
    const journals = await this.db.many(
      `SELECT j.*, json_agg(json_build_object('account', e.account, 'side', e.entry_type, 'amount', e.amount, 'providerId', e.provider_id) ORDER BY e.id) AS lines
         FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
        WHERE ($1::uuid IS NULL OR j.booking_id = $1) AND ($2::text IS NULL OR j.kind = $2)
          AND ($3::timestamptz IS NULL OR j.recorded_at >= $3) AND ($4::timestamptz IS NULL OR j.recorded_at < $4)
        GROUP BY j.id ORDER BY j.recorded_at DESC LIMIT $5`,
      [opts.bookingId ?? null, opts.kind ?? null, opts.from ?? null, opts.to ?? null, Math.min(opts.limit ?? 100, 1000)]);
    return journals;
  }

  /* ───────────── reconciliation vs MIPS settlement (§F.3, finance) ───────────── */

  async importSettlementReport(actor: Actor, r: { gateway: string; reportDate: string; currency: string; grossAmount: string; feesAmount?: string; netAmount: string; lines: Array<{ reference: string; amount: string; type?: string }> }) {
    if (!Array.isArray(r.lines)) throw new ValidationError('lines required');
    return this.db.one(
      `INSERT INTO settlement_reports (gateway, report_date, currency_code, gross_amount, fees_amount, net_amount, line_count, raw, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (gateway, report_date, currency_code) DO UPDATE SET gross_amount = EXCLUDED.gross_amount, fees_amount = EXCLUDED.fees_amount,
         net_amount = EXCLUDED.net_amount, line_count = EXCLUDED.line_count, raw = EXCLUDED.raw, imported_by = EXCLUDED.imported_by, imported_at = now()
       RETURNING *`,
      [r.gateway, r.reportDate, r.currency, r.grossAmount, r.feesAmount ?? '0', r.netAmount, r.lines.length, JSON.stringify(r), actor.userId]);
  }

  /**
   * Daily reconciliation: SUM(captures in ledger for the day) vs gateway gross, and
   * line-level matching of gateway references against captured payments.
   */
  async reconcile(runDate: string, currency: string, gateway = 'mips') {
    const ledger = await this.db.one(
      `SELECT COALESCE(SUM(e.amount), 0) AS captured FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id
        WHERE j.kind = 'payment_captured' AND e.account = 'cash_settlement' AND e.entry_type = 'debit'
          AND e.currency_code = $2 AND (j.recorded_at AT TIME ZONE 'Indian/Mauritius')::date = $1::date`, [runDate, currency]);
    const report = await this.db.one(`SELECT * FROM settlement_reports WHERE gateway = $1 AND report_date = $2 AND currency_code = $3`, [gateway, runDate, currency]);
    let unmatched: any[] = [];
    let status: 'matched' | 'mismatch' | 'pending_report' = 'pending_report';
    let difference: string | null = null;
    if (report) {
      const refs: Array<{ reference: string; amount: string }> = report.raw.lines ?? [];
      const ours = await this.db.many(
        `SELECT gateway_reference, amount_charged_to_customer FROM payments WHERE gateway = $1 AND currency_code = $2
            AND (captured_at AT TIME ZONE 'Indian/Mauritius')::date = $3::date AND status <> 'failed'`, [gateway, currency, runDate]);
      const ourMap = new Map(ours.map(o => [o.gateway_reference, o.amount_charged_to_customer]));
      const theirMap = new Map(refs.map(r => [r.reference, r.amount]));
      for (const [ref, amt] of theirMap) if (ourMap.get(ref) !== amt) unmatched.push({ reference: ref, gateway: amt, ledger: ourMap.get(ref) ?? null });
      for (const [ref, amt] of ourMap) if (!theirMap.has(ref)) unmatched.push({ reference: ref, gateway: null, ledger: amt });
      difference = (Number(report.gross_amount) - Number(ledger!.captured)).toFixed(2);
      status = Number(difference) === 0 && unmatched.length === 0 ? 'matched' : 'mismatch';
    }
    return this.db.one(
      `INSERT INTO reconciliation_runs (report_id, run_date, currency_code, ledger_captured, gateway_captured, difference, unmatched, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [report?.id ?? null, runDate, currency, ledger!.captured, report?.gross_amount ?? null, difference, JSON.stringify(unmatched), status]);
  }

  reconciliationRuns(limit = 60) {
    return this.db.many(`SELECT * FROM reconciliation_runs ORDER BY run_date DESC, created_at DESC LIMIT $1`, [limit]);
  }
}
