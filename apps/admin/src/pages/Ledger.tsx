import { useState } from 'react';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Loading, StatusPill, useAction, useApi, useData, useSession } from '../lib';

const ACCOUNT_HELP: Record<string, string> = {
  cash_settlement: 'Cash at the platform settlement bank (MIPS settles here)',
  provider_payable: 'Owed to providers — funds held until payout (the "virtual hold")',
  refund_liability: 'Refunds approved, not yet paid out',
  provider_clawback_receivable: 'Owed back by providers after post-payout refunds',
  platform_fee_revenue: 'Customer-side platform fee',
  platform_commission_revenue: 'Provider-side commission',
  platform_reserve: 'Reserve absorbing chargebacks, goodwill and write-offs',
  customer_receivable: 'Owed by customers (unused at launch)',
};

export function Ledger() {
  const api = useApi();
  const { role } = useSession();
  const [tab, setTab] = useState<'balances' | 'journals' | 'reconcile'>('balances');
  const tb = useData(() => api.admin.trialBalance('MUR'), []);
  const [kind, setKind] = useState('');
  const journals = useData(() => (tab === 'journals' ? api.admin.journals({ kind: kind || undefined }) : Promise.resolve([])), [tab, kind]);
  const runs = useData(() => (tab === 'reconcile' ? api.admin.reconciliationRuns() : Promise.resolve([])), [tab]);
  const act = useAction();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState('');

  const bal = Object.fromEntries((tb.data ?? []).map(r => [r.account, Number(r.balance)]));
  const assets = (bal.cash_settlement ?? 0) + (bal.provider_clawback_receivable ?? 0) + (bal.customer_receivable ?? 0);
  const claims = (bal.provider_payable ?? 0) + (bal.refund_liability ?? 0) + (bal.platform_fee_revenue ?? 0) + (bal.platform_commission_revenue ?? 0) + (bal.platform_reserve ?? 0);
  return (
    <>
      <div className="topbar"><div><h1>Ledger & reconciliation</h1><span className="muted">Append-only double-entry ledger — the source of truth for money (§F.3)</span></div></div>
      <div className="tabs">{(['balances', 'journals', 'reconcile'] as const).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {tab === 'balances' ? (tb.loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Account</th><th>Meaning</th><th className="num">Balance (MUR)</th></tr></thead>
            <tbody>{Object.keys(ACCOUNT_HELP).map(a => <tr key={a}><td className="mono">{a}</td><td className="muted">{ACCOUNT_HELP[a]}</td><td className="num">{formatMoney(bal[a] ?? 0, 'MUR')}</td></tr>)}</tbody>
          </table>
          <div style={{ marginTop: 12 }}>
            {Math.abs(assets - claims) < 0.005
              ? <Banner tone="success">Books balance: assets {formatMoney(assets, 'MUR')} = liabilities + revenue + reserve {formatMoney(claims, 'MUR')}</Banner>
              : <Banner tone="danger">Imbalance of {formatMoney(assets - claims, 'MUR')} — investigate immediately</Banner>}
          </div>
        </div>
      )) : null}
      {tab === 'journals' ? (
        <div className="card">
          <select style={{ maxWidth: 260, marginBottom: 12 }} value={kind} onChange={e => setKind(e.target.value)} aria-label="Journal kind">
            {['', 'payment_captured', 'payout_released', 'refund_initiated', 'refund_paid', 'chargeback_received', 'goodwill_refund', 'duplicate_payment', 'clawback_written_off'].map(k => <option key={k} value={k}>{k || 'All journal kinds'}</option>)}
          </select>
          {journals.loading ? <Loading /> : (journals.data ?? []).map((j: any) => (
            <div key={j.id} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
              <div className="row spread"><span><strong>{j.kind}</strong> <span className="muted">{j.memo}</span></span><span className="faint">{formatDateTime(j.recorded_at)} · {j.actor_type} · {j.booking_id ? <a href={`#/bookings/${j.booking_id}`}>booking</a> : '—'}</span></div>
              <table><tbody>{j.lines.map((l: any, i: number) => <tr key={i}><td className="mono" style={{ paddingLeft: l.side === 'credit' ? 30 : 10 }}>{l.account}</td><td className="num">{l.side === 'debit' ? formatMoney(l.amount, j.currency_code) : ''}</td><td className="num">{l.side === 'credit' ? formatMoney(l.amount, j.currency_code) : ''}</td></tr>)}</tbody></table>
            </div>
          ))}
        </div>
      ) : null}
      {tab === 'reconcile' ? (
        <div className="grid c2">
          <div className="card">
            <h2>Daily MIPS reconciliation</h2>
            <p className="muted">Import the gateway's settlement report for a day, then run reconciliation: ledger captures vs gateway gross, and line-by-line reference matching.</p>
            {role === 'finance' ? (
              <>
                <label>Settlement report JSON</label>
                <textarea style={{ minHeight: 140 }} className="mono" value={report} onChange={e => setReport(e.target.value)}
                  placeholder={'{"gateway":"mips","reportDate":"2026-10-07","currency":"MUR","grossAmount":"2645.00","netAmount":"2600.00","feesAmount":"45.00","lines":[{"reference":"TXN123","amount":"2645.00"}]}'} />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="secondary" disabled={!report.trim()} onClick={() => act.run(async () => api.admin.importSettlement(JSON.parse(report)), 'Report imported')}>Import report</button>
                  <input type="date" style={{ maxWidth: 170 }} value={date} onChange={e => setDate(e.target.value)} aria-label="Reconciliation date" />
                  <button onClick={() => act.run(() => api.admin.reconcile(date, 'MUR'), 'Reconciliation complete').then(runs.reload)}>Run reconciliation</button>
                </div>
              </>
            ) : <Banner>Reconciliation actions are restricted to finance operators.</Banner>}
          </div>
          <div className="card">
            <h2>Runs</h2>
            <table><thead><tr><th>Date</th><th className="num">Ledger</th><th className="num">Gateway</th><th className="num">Diff</th><th>Status</th></tr></thead>
              <tbody>{(runs.data ?? []).map((r: any) => (
                <tr key={r.id} title={JSON.stringify(r.unmatched)}><td>{String(r.run_date).slice(0, 10)}</td><td className="num">{formatMoney(r.ledger_captured, r.currency_code)}</td><td className="num">{r.gateway_captured ? formatMoney(r.gateway_captured, r.currency_code) : '—'}</td><td className="num">{r.difference ?? '—'}</td><td><StatusPill s={r.status} /> {r.unmatched?.length ? <span className="faint">{r.unmatched.length} unmatched</span> : null}</td></tr>
              ))}</tbody></table>
          </div>
        </div>
      ) : null}
    </>
  );
}
