'use client';
import { use, useState } from 'react';
import { formatDateTime, formatDistance, formatMoney, previewProviderNet } from '@trades/shared';
import { RequireAuth, msg, useAsync, useSession } from '../../../../src/client';

function JobView({ id }: { id: string }) {
  const { api, me } = useSession();
  const { data: r, error, reload } = useAsync(() => api.requests.get(id), [id]);
  const cfg = useAsync(() => api.catalog.publicConfig(me?.market?.id), [me?.market?.id]);
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [note, setNote] = useState<string | null>(null);
  if (error) return <div className="banner danger">{error}</div>;
  if (!r) return <p className="muted">Loading…</p>;
  const pct = cfg.data?.providerCommissionPct ?? 15;
  const net = Number(amount) > 0 ? previewProviderNet(Number(amount).toFixed(2), pct) : null;
  const open = r.myQuote?.counterOffers.find(c => c.status === 'proposed' && c.proposed_by === 'customer');
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>{r.title}</h1>
      <p className="muted" style={{ margin: 0 }}>{r.category.name} · {r.mode === 'urgent' ? 'Urgent' : formatDateTime(r.scheduledFor)} · {r.location.areaLabel ?? ''} · {formatDistance(r.distanceM)}</p>
      <div className="card">{r.description}</div>
      {note ? <div className="banner">{note}</div> : null}
      {r.myQuote && !['withdrawn', 'expired'].includes(r.myQuote.status) ? (
        <div className="card stack">
          <strong>Your quote: {formatMoney(r.myQuote.amount, r.currency)} · {r.myQuote.status}</strong>
          {open ? (
            <div className="row">
              <span>Customer offers {formatMoney(open.amount, r.currency)}</span>
              <button className="btn" onClick={async () => { try { const res = await api.quotes.respond(open.id, 'accept'); setNote(res.bookingId ? 'Booked! Waiting for customer payment.' : 'Accepted'); reload(); } catch (e) { setNote(msg(e)); } }}>Accept</button>
              <button className="btn secondary" onClick={async () => { await api.quotes.respond(open.id, 'reject'); reload(); }}>Decline</button>
            </div>
          ) : null}
        </div>
      ) : ['dispatched', 'quoted'].includes(r.status) ? (
        <div className="card">
          <label>Your price ({r.currency})</label><input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
          {net ? <p className="faint">After {pct}% commission you receive {formatMoney(net.net, r.currency)}.</p> : null}
          <label>Message</label><textarea value={message} onChange={e => setMessage(e.target.value)} />
          <div style={{ height: 10 }} />
          <button className="btn" disabled={!net} onClick={async () => { try { await api.quotes.submit({ requestId: r.id, amount: Number(amount).toFixed(2), message: message || undefined }); setNote('Quote sent'); reload(); } catch (e) { setNote(msg(e)); } }}>Send quote</button>
        </div>
      ) : <div className="banner">This job is no longer taking quotes.</div>}
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <main className="container" style={{ maxWidth: 720, padding: '32px 20px' }}><RequireAuth role="provider"><JobView id={id} /></RequireAuth></main>;
}
