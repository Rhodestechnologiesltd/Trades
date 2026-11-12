import { useMemo, useState } from 'react';
import { breakdownFromFrozen, computeSettlement, fromMajor, toMajorString } from '@trades/domain';
import { DISPUTE_REASONS, formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Loading, Pill, StatusPill, errMsg, go, useAction, useApi, useData, useSession } from '../lib';

export function Disputes() {
  const api = useApi();
  const { role } = useSession();
  const [status, setStatus] = useState('opened');
  const [routed, setRouted] = useState(role === 'finance' ? 'finance' : '');
  const { data, loading, error } = useData(() => api.admin.disputes({ status: status || undefined, routedTo: routed || undefined }), [status, routed]);
  return (
    <>
      <div className="topbar"><div><h1>Disputes</h1><span className="muted">Structured reasons, SLA per reason, payout frozen while open (§A.10, §C.9)</span></div></div>
      <div className="card row">
        <div className="tabs" style={{ margin: 0, border: 0 }}>{['opened', 'under_review', 'awaiting_evidence', 'resolved', ''].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s ? s.replace('_', ' ') : 'all'}</button>)}</div>
        <select style={{ maxWidth: 200 }} value={routed} onChange={e => setRouted(e.target.value)} aria-label="Queue"><option value="">All queues</option><option value="support">Support</option><option value="admin">Admin</option><option value="finance">Finance</option></select>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Booking</th><th>Reason</th><th>Source</th><th>Customer / Provider</th><th className="num">Value</th><th>Queue</th><th>Status</th><th>SLA due</th></tr></thead>
            <tbody>{data?.map(d => (
              <tr key={d.id} className="click" onClick={() => go(`/disputes/${d.id}`)}>
                <td className="mono">{d.reference}</td><td>{DISPUTE_REASONS[d.reason_code as keyof typeof DISPUTE_REASONS] ?? d.reason_code}</td>
                <td>{d.source === 'chargeback' ? <Pill tone="danger">chargeback</Pill> : 'platform'}</td>
                <td>{d.customer_name}<div className="faint">{d.provider_name}</div></td><td className="num">{formatMoney(d.agreed_amount, d.currency_code)}</td>
                <td>{d.routed_to}</td><td><StatusPill s={d.status} /></td>
                <td>{d.sla_breached && !['resolved', 'closed'].includes(d.status) ? <Pill tone="danger">{formatDateTime(d.sla_due_at)}</Pill> : formatDateTime(d.sla_due_at)}</td>
              </tr>
            ))}{!data?.length ? <tr><td colSpan={8} className="muted">Queue is empty.</td></tr> : null}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function DisputeDetail({ id }: { id: string }) {
  const api = useApi();
  const { data: d, loading, error, reload } = useData(() => api.admin.dispute(id), [id]);
  const booking = useData(() => (d ? api.admin.booking(d.booking_id) : Promise.resolve(null)), [d?.booking_id]);
  const act = useAction();
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(true);
  const [resolution, setResolution] = useState('refund_partial');
  const [adjusted, setAdjusted] = useState('');
  const [notes, setNotes] = useState('');

  const b = booking.data;
  const preview = useMemo(() => {
    if (!b || !d) return null;
    try {
      const cur = d.currency_code;
      const fb = breakdownFromFrozen(fromMajor(d.agreed_amount, cur).minor, cur, Math.round(Number(b.pricing.feePct) * 100), Math.round(Number(b.pricing.commissionPct) * 100));
      const adj = resolution === 'release_to_provider' ? fb.agreed : resolution === 'refund_full' ? fromMajor('0', cur) : fromMajor(adjusted || '0', cur);
      const s = computeSettlement(fb, adj);
      return { refund: toMajorString(s.refundToCustomer), providerNet: toMajorString(s.providerNetAfter), feeKept: toMajorString({ minor: fb.customerFee.minor - s.feeReduction.minor, currency: cur }), released: b.payout?.status === 'released' };
    } catch (e) { return { error: errMsg(e) } as any; }
  }, [b, d, resolution, adjusted]);

  if (loading) return <Loading />;
  if (error || !d) return <Banner tone="danger">{error}</Banner>;
  const open = ['opened', 'under_review', 'awaiting_evidence'].includes(d.status);
  return (
    <>
      <div className="topbar">
        <div><a href="#/disputes">← Disputes</a><h1>{DISPUTE_REASONS[d.reason_code]} · {d.reference}</h1><span className="muted">Opened {formatDateTime(d.opened_at)} · queue {d.routed_to} · SLA {formatDateTime(d.sla_due_at)}</span></div>
        <div className="row"><StatusPill s={d.status} /><a href={`#/bookings/${d.booking_id}`}>View booking</a></div>
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      <div className="grid c2">
        <div>
          <div className="card">
            <h2>Report</h2>
            <p>{d.description}</p>
            <div className="faint">Customer: {d.customer_name} · Provider: {d.provider_name} · Job value {formatMoney(d.agreed_amount, d.currency_code)} · source {d.source}</div>
          </div>
          <div className="card">
            <h2>Conversation & evidence</h2>
            {d.messages.map(m => (
              <div key={m.id} className={`chat ${m.internal_only ? 'internal' : ''}`}>
                <div className="row spread"><strong>{m.author_role}{m.internal_only ? ' (internal note)' : ''}</strong><span className="faint">{formatDateTime(m.created_at)}</span></div>
                <div>{m.body}</div>
                <div className="row">{m.attachments.filter(Boolean).map(u => <a key={u!} href={u!} target="_blank" rel="noreferrer"><img className="doc-thumb" src={u!} alt="evidence" /></a>)}</div>
              </div>
            ))}
            {open ? (
              <>
                <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Message to both parties, or an internal note" aria-label="Message" />
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={internal} onChange={e => setInternal(e.target.checked)} /> Internal note (staff only)</label>
                  <button className="small" disabled={!note.trim()} onClick={async () => { if (await act.run(() => api.admin.disputeMessage(id, note, internal), 'Posted')) { setNote(''); reload(); } }}>Post</button>
                  <button className="small secondary" disabled={!note.trim()} onClick={async () => { if (await act.run(() => api.admin.disputeRequestEvidence(id, note, 48), 'Evidence requested (48h)')) { setNote(''); reload(); } }}>Request evidence</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div>
          {d.status === 'opened' ? <div className="card"><button onClick={() => act.run(() => api.admin.disputeStartReview(id), 'Assigned to you').then(reload)}>Start review (assign to me)</button></div> : null}
          {open ? (
            <div className="card">
              <h2>Resolve</h2>
              <label>Outcome</label>
              <select value={resolution} onChange={e => setResolution(e.target.value)}>
                <option value="release_to_provider">Release payment to provider (no refund)</option>
                <option value="refund_partial">Partial refund</option>
                <option value="split">Split settlement</option>
                <option value="refund_full">Full refund</option>
              </select>
              {['refund_partial', 'split'].includes(resolution) ? (
                <><label>Fair value of the work done ({d.currency_code})</label><input value={adjusted} onChange={e => setAdjusted(e.target.value)} inputMode="decimal" placeholder={`between 0 and ${d.agreed_amount}`} /></>
              ) : null}
              {preview && !preview.error ? (
                <div className="kv" style={{ marginTop: 12 }}>
                  <div>Refund to customer</div><div><strong>{formatMoney(preview.refund, d.currency_code)}</strong></div>
                  <div>Provider receives</div><div>{formatMoney(preview.providerNet, d.currency_code)}{preview.released ? ' (already paid → clawback)' : ''}</div>
                  <div>Platform fee kept</div><div>{formatMoney(preview.feeKept, d.currency_code)}</div>
                </div>
              ) : preview?.error ? <Banner tone="warning">{preview.error}</Banner> : null}
              <label>Resolution notes (mandatory, shared with both parties)</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} />
              <div style={{ height: 10 }} />
              <button disabled={act.busy || notes.trim().length < 10} onClick={async () => {
                if (await act.run(() => api.admin.resolveDispute(id, { resolution, adjustedAmount: ['refund_partial', 'split'].includes(resolution) ? adjusted : undefined, notes }), 'Dispute resolved')) reload();
              }}>Resolve dispute</button>
              <p className="faint">Fees are recomputed pro-rata on the adjusted value; the ledger posts reversals automatically. Support agents can only resolve no-show / incomplete work / other within their goodwill cap.</p>
            </div>
          ) : (
            <div className="card"><h2>Outcome</h2><div className="kv"><div>Resolution</div><div>{d.resolution}</div><div>Adjusted value</div><div>{formatMoney(d.resolution_amount, d.currency_code)}</div><div>Notes</div><div>{d.resolution_notes}</div></div></div>
          )}
          <div className="card"><h2>History</h2><div className="timeline">{d.timeline.map((t, i) => <div key={i}><strong>{t.trigger}</strong> → {t.to_state} <span className="faint">{t.actor_type} · {formatDateTime(t.occurred_at)}</span></div>)}</div></div>
        </div>
      </div>
    </>
  );
}
