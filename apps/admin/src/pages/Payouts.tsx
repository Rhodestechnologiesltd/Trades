import { useState } from 'react';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Loading, Modal, StatusPill, useAction, useApi, useData, useRoute, useSession } from '../lib';

export function Payouts() {
  const api = useApi();
  const { role } = useSession();
  const { query } = useRoute();
  const [status, setStatus] = useState(query.get('status') ?? 'payout_pending');
  const { data, loading, error, reload } = useData(() => api.admin.payouts(status || undefined), [status]);
  const markets = useData(() => api.admin.markets(), []);
  const act = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ kind: 'release' | 'hold' | 'unhold' | 'confirm'; bookingId?: string } | null>(null);
  const [reason, setReason] = useState('');
  const total = (data ?? []).reduce((s, p) => s + Number(p.net_payout_amount) - Number(p.clawback_recovered), 0);

  async function exportBatch() {
    const marketId = markets.data?.[0]?.id;
    if (!marketId) return;
    const res: Response = await api.admin.exportBatch(marketId);
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `payout-batch-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    reload();
  }

  return (
    <>
      <div className="topbar">
        <div><h1>Payouts</h1><span className="muted">Released automatically at T+48h after approval; one payout per booking, idempotent disbursement (§F.4)</span></div>
        {role === 'finance' ? <div className="row"><button className="secondary" onClick={exportBatch}>Export bank batch (CSV)</button><button disabled={!selected.size} onClick={() => setModal({ kind: 'confirm' })}>Confirm paid ({selected.size})</button></div> : null}
      </div>
      <div className="tabs">{['payout_pending', 'processing', 'held', 'released', 'cancelled', 'clawed_back', ''].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => { setStatus(s); setSelected(new Set()); }}>{s ? s.replace('_', ' ') : 'all'}</button>)}</div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <div className="row spread" style={{ marginBottom: 8 }}><span className="muted">{data?.length} payouts · {formatMoney(total, 'MUR')} to send</span></div>
          <table>
            <thead><tr>{status === 'processing' ? <th></th> : null}<th>Booking</th><th>Provider</th><th className="num">Gross</th><th className="num">Commission</th><th className="num">Net</th><th className="num">Clawback</th><th>Account</th><th>Eligible</th><th>Status</th><th></th></tr></thead>
            <tbody>{data?.map(p => (
              <tr key={p.id}>
                {status === 'processing' ? <td><input type="checkbox" style={{ width: 'auto' }} checked={selected.has(p.id)} onChange={e => { const s = new Set(selected); if (e.target.checked) s.add(p.id); else s.delete(p.id); setSelected(s); }} aria-label="Select payout" /></td> : null}
                <td><a href={`#/bookings/${p.booking_id}`} className="mono">{p.reference}</a></td><td>{p.provider_name}</td>
                <td className="num">{formatMoney(p.gross_amount, p.currency_code)}</td><td className="num">{formatMoney(p.commission_deducted, p.currency_code)}</td>
                <td className="num"><strong>{formatMoney(p.net_payout_amount, p.currency_code)}</strong></td><td className="num">{Number(p.clawback_recovered) ? formatMoney(p.clawback_recovered, p.currency_code) : '—'}</td>
                <td>{p.account_last4 ? `•••• ${p.account_last4}` : <span className="pill danger">no account</span>}{p.payouts_allowed_after && new Date(p.payouts_allowed_after) > new Date() ? <div className="faint">cool-off until {formatDateTime(p.payouts_allowed_after)}</div> : null}</td>
                <td>{formatDateTime(p.eligible_at)}</td>
                <td><StatusPill s={p.status} />{p.dispute_flag ? <div className="faint">dispute</div> : null}{p.hold_reason ? <div className="faint">{p.hold_reason}</div> : null}{p.last_error ? <div className="faint">{p.last_error}</div> : null}</td>
                <td className="row">
                  {p.status === 'payout_pending' ? <><button className="small secondary" onClick={() => setModal({ kind: 'hold', bookingId: p.booking_id })}>Hold</button><button className="small" onClick={() => setModal({ kind: 'release', bookingId: p.booking_id })}>Release now</button></> : null}
                  {p.status === 'held' && !p.dispute_flag ? <button className="small secondary" onClick={() => setModal({ kind: 'unhold', bookingId: p.booking_id })}>Unhold</button> : null}
                </td>
              </tr>
            ))}{!data?.length ? <tr><td colSpan={11} className="muted">No payouts.</td></tr> : null}</tbody>
          </table>
        </div>
      )}
      {modal ? (
        <Modal title={{ release: 'Release payout now', hold: 'Hold payout', unhold: 'Remove hold', confirm: 'Confirm bank batch paid' }[modal.kind]} onClose={() => setModal(null)}>
          <label>{modal.kind === 'confirm' ? 'Bank batch reference' : 'Reason (audit-logged)'}</label>
          <input value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={reason.trim().length < 3 || act.busy} onClick={async () => {
            const ok = await act.run(() => modal.kind === 'confirm' ? api.admin.confirmBatch([...selected], reason)
              : modal.kind === 'release' ? api.admin.releasePayout(modal.bookingId!, reason)
              : modal.kind === 'hold' ? api.admin.holdPayout(modal.bookingId!, reason)
              : api.admin.unholdPayout(modal.bookingId!, reason));
            if (ok) { setModal(null); setReason(''); setSelected(new Set()); reload(); }
          }}>Confirm</button>
        </Modal>
      ) : null}
    </>
  );
}
