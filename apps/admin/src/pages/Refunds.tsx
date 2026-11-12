import { useState } from 'react';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Loading, Modal, Pill, StatusPill, useAction, useApi, useData, useSession } from '../lib';

export function Refunds() {
  const api = useApi();
  const { role } = useSession();
  const [status, setStatus] = useState('initiated');
  const { data, loading, error, reload } = useData(() => api.admin.refunds(status || undefined), [status]);
  const act = useAction();
  const [paying, setPaying] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [cb, setCb] = useState(false);
  const [cbForm, setCbForm] = useState({ gatewayReference: '', amount: '', reference: '', respondBy: '', reason: '' });
  return (
    <>
      <div className="topbar">
        <div><h1>Refunds & chargebacks</h1><span className="muted">Gateway refunds retry automatically; refunds outside the gateway window are paid by bank transfer from reserve (§F.5)</span></div>
        {role === 'finance' ? <button className="danger" onClick={() => setCb(true)}>Record chargeback…</button> : null}
      </div>
      <div className="tabs">{['initiated', 'processed', 'failed', ''].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s || 'all'}</button>)}</div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Booking</th><th className="num">Amount</th><th>Reason</th><th>Rail</th><th>By</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>{data?.map(r => (
              <tr key={r.id}>
                <td><a className="mono" href={`#/bookings/${r.booking_id}`}>{r.reference}</a></td><td className="num">{formatMoney(r.amount, r.currency_code)}</td>
                <td style={{ maxWidth: 360 }}>{r.reason}</td><td>{r.rail === 'bank_transfer' ? <Pill tone="warning">bank transfer</Pill> : 'gateway'}</td>
                <td>{r.initiated_by_type}</td><td><StatusPill s={r.status} /></td><td>{formatDateTime(r.created_at)}</td>
                <td>{r.status === 'initiated' && r.rail === 'bank_transfer' && role === 'finance' ? <button className="small" onClick={() => setPaying(r.id)}>Mark paid</button> : null}</td>
              </tr>
            ))}{!data?.length ? <tr><td colSpan={8} className="muted">None.</td></tr> : null}</tbody>
          </table>
        </div>
      )}
      {paying ? (
        <Modal title="Mark refund paid" onClose={() => setPaying(null)}>
          <label>Bank transfer reference</label><input value={ref} onChange={e => setRef(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={ref.length < 2} onClick={async () => { if (await act.run(() => api.admin.markRefundPaid(paying, ref), 'Refund marked paid')) { setPaying(null); setRef(''); reload(); } }}>Confirm</button>
        </Modal>
      ) : null}
      {cb ? (
        <Modal title="Record card chargeback" onClose={() => setCb(false)}>
          <p className="muted">Freezes the provider payout immediately, opens a finance dispute and debits the reserve. Respond to the acquirer before the deadline.</p>
          <label>Gateway transaction reference</label><input value={cbForm.gatewayReference} onChange={e => setCbForm({ ...cbForm, gatewayReference: e.target.value })} />
          <label>Chargeback reference</label><input value={cbForm.reference} onChange={e => setCbForm({ ...cbForm, reference: e.target.value })} />
          <label>Amount</label><input value={cbForm.amount} onChange={e => setCbForm({ ...cbForm, amount: e.target.value })} inputMode="decimal" />
          <label>Respond by</label><input type="date" value={cbForm.respondBy} onChange={e => setCbForm({ ...cbForm, respondBy: e.target.value })} />
          <label>Reason given by the issuer</label><input value={cbForm.reason} onChange={e => setCbForm({ ...cbForm, reason: e.target.value })} />
          <div style={{ height: 12 }} />
          <button className="danger" disabled={!cbForm.gatewayReference || !cbForm.reference} onClick={async () => {
            if (await act.run(() => api.admin.chargeback({ ...cbForm, respondBy: cbForm.respondBy ? new Date(cbForm.respondBy).toISOString() : undefined, amount: cbForm.amount || undefined }), 'Chargeback recorded')) setCb(false);
          }}>Record chargeback</button>
        </Modal>
      ) : null}
    </>
  );
}
