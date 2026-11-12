'use client';
import { use, useEffect, useState } from 'react';
import { QuoteView, REQUEST_STATUS, formatDateTime, formatMoney, previewCustomerTotal, timeUntil } from '@trades/shared';
import { RequireAuth, msg, useAsync, useSession } from '../../../src/client';

function QuoteRow({ q, feePct, onChange }: { q: QuoteView; feePct: number; onChange: () => void }) {
  const { api } = useSession();
  const [offer, setOffer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const last = q.counterOffers[q.counterOffers.length - 1];
  const openProvider = last?.status === 'proposed' && last.proposed_by === 'provider' ? last : null;
  const waiting = last?.status === 'proposed' && last.proposed_by === 'customer';
  const current = openProvider?.amount ?? [...q.counterOffers].reverse().find(c => c.proposed_by === 'provider')?.amount ?? q.amount;
  const done = (r: { bookingId?: string }) => { if (r.bookingId) window.location.href = `/bookings/${r.bookingId}?pay=1`; else onChange(); };
  const wrap = (fn: () => Promise<any>) => async () => { setError(null); try { done(await fn()); } catch (e) { setError(msg(e)); } };
  return (
    <div className="card stack">
      <div className="row spread">
        <div><strong>{q.provider.name}</strong> {q.provider.verified ? <span className="pill success">✓ verified</span> : null}
          <div className="faint">{q.provider.rating ? `★ ${q.provider.rating} (${q.provider.ratingCount})` : 'New pro'} · {q.provider.jobsCompleted} jobs{q.etaMin ? ` · ~${q.etaMin} min away` : ''}</div></div>
        <div style={{ textAlign: 'right' }}><div style={{ fontSize: 22, fontWeight: 800 }}>{formatMoney(current, q.currency)}</div><div className="faint">{formatMoney(previewCustomerTotal(current, feePct).total, q.currency)} incl. fee · valid {timeUntil(q.validUntil)}</div></div>
      </div>
      {q.message ? <p className="muted" style={{ margin: 0 }}>"{q.message}"</p> : null}
      {q.counterOffers.map(c => <div key={c.id} className="faint">{c.proposed_by === 'customer' ? 'You offered' : 'Pro offered'} {formatMoney(c.amount, c.currency_code)} · {c.status}</div>)}
      {error ? <div className="banner danger">{error}</div> : null}
      {waiting ? <span className="pill info">Waiting for the pro to answer your offer</span> : (
        <div className="row">
          <button className="btn" onClick={wrap(() => api.quotes.accept(q.id))}>Accept {formatMoney(current, q.currency)}</button>
          {openProvider ? <button className="btn secondary" onClick={wrap(() => api.quotes.respond(openProvider.id, 'reject'))}>Decline offer</button> : null}
          {(!q.counterOffers.length || openProvider) && !q.isInstantAccept ? (
            <div className="row">
              <input style={{ width: 130 }} inputMode="decimal" placeholder="Your price" value={offer} onChange={e => setOffer(e.target.value)} aria-label="Counter-offer" />
              <button className="btn secondary" disabled={!offer} onClick={wrap(() => (openProvider ? api.quotes.respond(openProvider.id, 'counter', Number(offer).toFixed(2)) : api.quotes.counter(q.id, Number(offer).toFixed(2))))}>Make offer</button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RequestView({ id }: { id: string }) {
  const { api, me } = useSession();
  const { data: r, error, reload } = useAsync(() => api.requests.get(id), [id], { pollMs: 10_000 });
  const cfg = useAsync(() => api.catalog.publicConfig(me?.market?.id), [me?.market?.id]);
  useEffect(() => { if (r?.bookingId) window.location.href = `/bookings/${r.bookingId}`; }, [r?.bookingId]);
  if (error) return <div className="banner danger">{error}</div>;
  if (!r) return <p className="muted">Loading…</p>;
  const live = ['requested', 'matching', 'dispatched', 'quoted'].includes(r.status);
  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>{r.title}</h1><span className={`pill ${REQUEST_STATUS[r.status].tone}`}>{REQUEST_STATUS[r.status].label}</span></div>
      <p className="muted" style={{ margin: 0 }}>{r.category.name} · {r.mode === 'urgent' ? 'Urgent' : formatDateTime(r.scheduledFor)} · {r.location.areaLabel ?? r.location.addressText ?? ''}</p>
      <div className="card">{r.description}</div>
      {live && !r.quotes?.length ? <div className="banner">Finding pros… {r.dispatchStats?.notified ?? 0} notified so far. This page updates automatically.</div> : null}
      {r.status === 'expired' ? <div className="banner warning">No pros were available. <a href={`/request/new?categoryId=${r.category.id}`}>Try again</a></div> : null}
      {(r.quotes ?? []).map(q => <QuoteRow key={q.id} q={q} feePct={cfg.data?.customerFeePct ?? 15} onChange={reload} />)}
      {live ? <button className="btn ghost" onClick={async () => { await api.requests.cancel(r.id, 'Customer cancelled'); reload(); }}>Cancel request</button> : null}
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <main className="container" style={{ maxWidth: 760, padding: '32px 20px' }}><RequireAuth><RequestView id={id} /></RequireAuth></main>;
}
