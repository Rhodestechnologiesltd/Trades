import { useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, Modal, useAction, useApi, useData, useSession } from '../lib';

const HELP: Record<string, string> = {
  fees: 'Platform default fee (added to the customer charge) and commission (deducted from provider payout), in basis points. Spec default 1500 / 1500 = 30% gross take — confirm with the business owner.',
  timing: 'Payment window, auto-approve, T+48h payout delay, dispute window, review window, no-show grace (seconds).',
  negotiation: 'Counter-offer round cap.',
  cancellation: 'Free cancellation window and late-cancellation fee.',
  abuse: 'Rate limits and fraud thresholds.',
  dispatch: 'Per-mode overrides: initialRadiusM, maxRadiusM, expansionFactor, minCandidates, responseSlaSec, waveSize, quoteValiditySec.',
  ranking: 'Per-mode ranking weight overrides: distance, rating, workload, responseSpeed, urgentReliability, conversion.',
  support_goodwill_cap: 'Max goodwill refund a support agent can issue (minor units per currency).',
  payout_account_cooloff_sec: 'Payout hold after a provider changes payout account.',
};

export function Settings() {
  const api = useApi();
  const { role } = useSession();
  const cfg = useData(() => api.admin.config(), []);
  const markets = useData(() => api.admin.markets(), []);
  const act = useAction();
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);
  const [mEdit, setMEdit] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  if (cfg.loading || markets.loading) return <Loading />;
  const fees = cfg.data?.find(c => c.key === 'fees')?.value;
  return (
    <>
      <div className="topbar"><div><h1>Fees, markets & policies</h1><span className="muted">Changes apply to new bookings only — existing bookings keep their frozen fees (§F.2)</span></div></div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {fees ? (
        <Banner tone={fees.customerFeeBps + fees.providerCommissionBps > 2000 ? 'warning' : 'info'}>
          Current model: customer pays agreed + {fees.customerFeeBps / 100}%, provider receives agreed − {fees.providerCommissionBps / 100}% → platform take {(fees.customerFeeBps + fees.providerCommissionBps) / 100}% of job value.
          {fees.customerFeeBps + fees.providerCommissionBps > 2000 ? ' This is above typical marketplace take-rates (10–20%).' : ''}
        </Banner>
      ) : null}
      <div className="card">
        <h2>Markets</h2>
        <table>
          <thead><tr><th>Market</th><th>Currency</th><th>Timezone</th><th className="num">Fee override</th><th className="num">Commission override</th><th className="num">Max radius</th><th>Gateway</th><th>Active</th><th></th></tr></thead>
          <tbody>{markets.data?.map(m => (
            <tr key={m.id}><td>{m.city}, {m.country_code}</td><td>{m.currency_code}</td><td>{m.timezone}</td><td className="num">{m.customer_fee_bps ?? '—'}</td><td className="num">{m.provider_commission_bps ?? '—'}</td>
              <td className="num">{m.max_dispatch_radius_m / 1000} km</td><td>{m.payment_gateway}</td><td>{m.is_active ? 'yes' : 'no'}</td>
              <td>{role === 'admin' ? <button className="small secondary" onClick={() => setMEdit({ ...m })}>Edit</button> : null}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="card">
        <h2>Platform configuration</h2>
        <table>
          <thead><tr><th>Key</th><th>Value</th><th>Updated</th><th></th></tr></thead>
          <tbody>{cfg.data?.map(c => (
            <tr key={c.key}>
              <td className="mono"><strong>{c.key}</strong><div className="faint" style={{ maxWidth: 320, fontFamily: 'inherit' }}>{HELP[c.key] ?? c.description}</div></td>
              <td className="mono" style={{ maxWidth: 480, wordBreak: 'break-all' }}>{JSON.stringify(c.value)}</td>
              <td className="faint">{formatDateTime(c.updated_at)}</td>
              <td>{role === 'admin' ? <button className="small secondary" onClick={() => setEdit({ key: c.key, text: JSON.stringify(c.value, null, 2) })}>Edit</button> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit ? (
        <Modal title={`Edit ${edit.key}`} onClose={() => setEdit(null)}>
          <p className="muted">{HELP[edit.key]}</p>
          <textarea className="mono" style={{ minHeight: 220 }} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} />
          <label>Reason (audit-logged)</label><input value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={reason.length < 3 || act.busy} onClick={async () => {
            let value: unknown;
            try { value = JSON.parse(edit.text); } catch { act.setMsg({ tone: 'danger', text: 'Invalid JSON' }); return; }
            if (await act.run(() => api.admin.setConfig(edit.key, value, reason), 'Configuration saved')) { setEdit(null); setReason(''); cfg.reload(); }
          }}>Save</button>
        </Modal>
      ) : null}
      {mEdit ? (
        <Modal title={`Edit ${mEdit.city}`} onClose={() => setMEdit(null)}>
          <label>Customer fee override (bps, blank = platform default)</label><input value={mEdit.customer_fee_bps ?? ''} onChange={e => setMEdit({ ...mEdit, customer_fee_bps: e.target.value })} />
          <label>Provider commission override (bps)</label><input value={mEdit.provider_commission_bps ?? ''} onChange={e => setMEdit({ ...mEdit, provider_commission_bps: e.target.value })} />
          <label>Max dispatch radius (m)</label><input value={mEdit.max_dispatch_radius_m} onChange={e => setMEdit({ ...mEdit, max_dispatch_radius_m: e.target.value })} />
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={mEdit.is_active} onChange={e => setMEdit({ ...mEdit, is_active: e.target.checked })} /> Active</label>
          <label>Reason</label><input value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={reason.length < 3} onClick={async () => {
            const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
            if (await act.run(() => api.admin.updateMarket(mEdit.id, { customerFeeBps: n(mEdit.customer_fee_bps), providerCommissionBps: n(mEdit.provider_commission_bps), maxDispatchRadiusM: n(mEdit.max_dispatch_radius_m), isActive: mEdit.is_active, reason }), 'Market saved')) { setMEdit(null); setReason(''); markets.reload(); }
          }}>Save</button>
        </Modal>
      ) : null}
    </>
  );
}
