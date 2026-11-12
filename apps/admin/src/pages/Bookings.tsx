import { useState } from 'react';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Loading, Modal, StatusPill, go, useAction, useApi, useData, useSession } from '../lib';

const STATUSES = ['', 'payment_pending', 'assigned', 'in_progress', 'completed_by_provider', 'disputed', 'payout_pending', 'payout_released', 'refund_pending', 'refunded', 'cancelled'];

export function Bookings() {
  const api = useApi();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading, error } = useData(() => api.admin.bookings({ status: status || undefined, q: search || undefined }), [status, search]);
  return (
    <>
      <div className="topbar"><div><h1>Bookings</h1><span className="muted">Search by reference, customer or provider</span></div></div>
      <div className="card row">
        <form className="row" style={{ flex: 1 }} onSubmit={e => { e.preventDefault(); setSearch(q); }}>
          <input style={{ maxWidth: 320 }} placeholder="TR-XXXXXX, name…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search bookings" />
          <button type="submit" className="secondary">Search</button>
        </form>
        <select style={{ maxWidth: 240 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status filter">{STATUSES.map(s => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'All statuses'}</option>)}</select>
      </div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Reference</th><th>Category</th><th>Customer</th><th>Provider</th><th className="num">Agreed</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{data?.map(b => (
              <tr key={b.id} className="click" onClick={() => go(`/bookings/${b.id}`)}>
                <td className="mono">{b.reference}</td><td>{b.category}</td><td>{b.customer_name}</td><td>{b.provider_name}</td>
                <td className="num">{formatMoney(b.agreed_amount, b.currency_code)}</td><td><StatusPill s={b.status} /></td><td>{formatDateTime(b.created_at)}</td>
              </tr>
            ))}{!data?.length ? <tr><td colSpan={7} className="muted">No bookings found.</td></tr> : null}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function BookingDetail({ id }: { id: string }) {
  const api = useApi();
  const { role } = useSession();
  const { data: b, loading, error, reload } = useData(() => api.admin.booking(id), [id]);
  const act = useAction();
  const [modal, setModal] = useState<'goodwill' | 'cancel' | 'release' | 'hold' | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  if (loading) return <Loading />;
  if (error || !b) return <Banner tone="danger">{error}</Banner>;
  const cur = b.pricing.total?.currency ?? 'MUR';
  const close = () => { setModal(null); setAmount(''); setReason(''); };

  return (
    <>
      <div className="topbar">
        <div><a href="#/bookings">← Bookings</a><h1>{b.reference} · {b.title}</h1><span className="muted">{b.category.name} · {b.mode}</span></div>
        <div className="row">
          <StatusPill s={b.status} />
          {['payment_authorized', 'assigned', 'in_progress', 'payment_pending'].includes(b.status) && role !== 'finance' ? <button className="danger" onClick={() => setModal('cancel')}>Cancel booking…</button> : null}
          {b.payment?.status && ['captured', 'partially_refunded'].includes(b.payment.status) ? <button className="secondary" onClick={() => setModal('goodwill')}>Goodwill refund…</button> : null}
          {b.payout?.status === 'payout_pending' && role !== 'support' ? <><button className="secondary" onClick={() => setModal('hold')}>Hold payout</button><button onClick={() => setModal('release')}>Release payout now…</button></> : null}
          {b.dispute ? <a className="btn" href={`#/disputes/${b.dispute.id}`}>Open dispute</a> : null}
        </div>
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      <div className="grid c2">
        <div>
          <div className="card">
            <h2>Parties & job</h2>
            <div className="kv">
              <div>Customer</div><div>{b.customer.name}</div>
              <div>Provider</div><div><a href={`#/providers/${b.provider.id}`}>{b.provider.name}</a> {b.provider.rating ? `★ ${b.provider.rating}` : ''}</div>
              <div>Scheduled</div><div>{b.scheduledStartAt ? formatDateTime(b.scheduledStartAt) : 'ASAP (urgent)'}</div>
              <div>Address</div><div>{b.location.addressText ?? `${b.location.lat}, ${b.location.lng}`}</div>
              <div>Description</div><div>{b.description}</div>
              {b.completionNotes ? <><div>Completion notes</div><div>{b.completionNotes}</div></> : null}
              {b.cancelReason ? <><div>Cancellation</div><div>{b.cancelReason}</div></> : null}
            </div>
          </div>
          <div className="card">
            <h2>Money</h2>
            <div className="kv">
              <div>Agreed</div><div>{formatMoney(b.pricing.agreed?.amount, cur)}</div>
              <div>Customer fee</div><div>{formatMoney(b.pricing.platformFee?.amount, cur)}</div>
              <div>Customer charged</div><div><strong>{formatMoney(b.pricing.total?.amount, cur)}</strong></div>
              <div>Commission</div><div>{formatMoney(b.pricing.commission?.amount, cur)}</div>
              <div>Provider net</div><div>{formatMoney(b.pricing.providerNet?.amount, cur)}</div>
              <div>Platform gross</div><div>{formatMoney(b.pricing.platformGross?.amount, cur)}</div>
              <div>Payment</div><div>{b.payment ? <><StatusPill s={b.payment.status} /> {b.payment.card_brand} •••• {b.payment.card_last4} · refunded {formatMoney(b.payment.amount_refunded, cur)}</> : '—'}</div>
              <div>Payout</div><div>{b.payout ? <><StatusPill s={b.payout.status} /> {formatMoney(b.payout.net_payout_amount, cur)} · eligible {formatDateTime(b.payout.eligible_at)}{b.payout.hold_reason ? ` · ${b.payout.hold_reason}` : ''}</> : '—'}</div>
            </div>
          </div>
          <div className="card">
            <h2>Ledger journals</h2>
            {b.journals.map((j: any) => (
              <div key={j.id} style={{ marginBottom: 10 }}>
                <div className="row spread"><strong>{j.kind}</strong><span className="faint">{formatDateTime(j.recorded_at)} · {j.actor_type}</span></div>
                <table><tbody>{j.lines.map((l: any, i: number) => <tr key={i}><td className="mono">{l.account}</td><td className="num">{l.side === 'debit' ? formatMoney(l.amount, cur) : ''}</td><td className="num">{l.side === 'credit' ? formatMoney(l.amount, cur) : ''}</td></tr>)}</tbody></table>
              </div>
            ))}
            {!b.journals.length ? <p className="muted">No money has moved yet.</p> : null}
          </div>
        </div>
        <div>
          <div className="card"><h2>Lifecycle (event-sourced)</h2><div className="timeline">{b.timeline.map((t: any, i: number) => <div key={i}><strong>{t.trigger}</strong> → {t.to_state} <span className="faint">· {t.actor_type} · {formatDateTime(t.occurred_at)}</span></div>)}</div></div>
          <div className="card"><h2>Job events</h2>{b.jobEvents.map((e: any, i: number) => <div key={i} className="faint">{formatDateTime(e.occurred_at)} — {e.event_type}{e.within_geofence === false ? ' ⚠ outside geofence' : e.within_geofence ? ' ✓ on site' : ''}</div>)}</div>
          <div className="card">
            <h2>Dispatch log</h2>
            <table><thead><tr><th>Provider</th><th>Wave</th><th className="num">Score</th><th className="num">km</th><th>Status</th></tr></thead>
              <tbody>{b.dispatchLog.map((d: any) => <tr key={d.id}><td>{d.full_name}</td><td>{d.wave}</td><td className="num">{d.rank_score ? Number(d.rank_score).toFixed(3) : '—'}</td><td className="num">{(d.distance_m / 1000).toFixed(1)}</td><td><StatusPill s={d.status} /></td></tr>)}</tbody></table>
          </div>
        </div>
      </div>
      {modal ? (
        <Modal title={{ goodwill: 'Goodwill refund', cancel: 'Cancel booking', release: 'Release payout now', hold: 'Hold payout' }[modal]} onClose={close}>
          {modal === 'goodwill' ? <><p className="muted">Platform-funded credit to the customer. The provider's payout is not affected. Support agents are capped.</p><label>Amount ({cur})</label><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></> : null}
          {modal === 'cancel' ? <p className="muted">Platform cancellation refunds the customer in full and frees the provider.</p> : null}
          {modal === 'release' ? <p className="muted">Overrides the T+48h hold. Only do this with a documented reason; it is audit-logged.</p> : null}
          <label>Reason (required, audit-logged)</label><textarea value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={act.busy || reason.trim().length < (modal === 'goodwill' ? 10 : 3)} className={modal === 'cancel' ? 'danger' : ''} onClick={async () => {
            const ok = await act.run(() => modal === 'goodwill' ? api.admin.goodwillRefund(id, amount, reason)
              : modal === 'cancel' ? api.bookings.cancel(id, reason)
              : modal === 'release' ? api.admin.releasePayout(id, reason)
              : api.admin.holdPayout(id, reason));
            if (ok) { close(); reload(); }
          }}>Confirm</button>
        </Modal>
      ) : null}
    </>
  );
}
