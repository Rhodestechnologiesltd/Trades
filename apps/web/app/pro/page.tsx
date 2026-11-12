'use client';
import { BOOKING_STATUS, formatDateTime, formatDistance, formatMoney } from '@trades/shared';
import { RequireAuth, useAsync, useSession } from '../../src/client';

/** Lightweight provider web portal (§B.2): job feed, quotes and bookings from a desktop. Field actions stay in the mobile app. */
function ProPortal() {
  const { api, me } = useSession();
  const jobs = useAsync(() => api.dispatch.jobs(), [], { pollMs: 30_000 });
  const quotes = useAsync(() => api.quotes.mine(), []);
  const bookings = useAsync(() => api.bookings.history({ status: 'active' }), []);
  const earnings = useAsync(() => api.providers.earnings(), []);
  if (me?.verification_status !== 'verified') return <div className="banner warning">Your account is {me?.verification_status}. Complete verification in the Trades Pro app to start receiving jobs.</div>;
  const all = [...(jobs.data?.dispatched ?? []), ...(jobs.data?.open ?? [])];
  const s = earnings.data?.summary;
  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>Pro portal</h1><span className={`pill ${me.availability_status === 'online' ? 'success' : ''}`}>{me.availability_status}</span></div>
      <div className="grid two">
        <div className="card"><div className="faint">Paid out</div><div style={{ fontSize: 24, fontWeight: 800 }}>{formatMoney(s?.paid_out ?? 0, s?.currency_code ?? 'MUR')}</div><div className="faint">Scheduled {formatMoney(s?.pending ?? 0, s?.currency_code ?? 'MUR')}</div></div>
        <div className="card"><div className="faint">Active jobs</div><div style={{ fontSize: 24, fontWeight: 800 }}>{bookings.data?.items.length ?? 0}</div><div className="faint">Use the mobile app on site to start and complete jobs.</div></div>
      </div>
      <h2>Jobs near you</h2>
      {!all.length ? <p className="muted">No open jobs right now.</p> : all.map(j => (
        <a key={j.id} className="card link row spread" href={`/pro/requests/${j.id}`}>
          <div><strong>{j.request_mode === 'urgent' ? '⚡ ' : ''}{j.title}</strong><div className="faint">{j.category_name} · {j.area_label ?? ''} · {formatDistance(j.distance_m)}</div></div>
          <div className="faint">{j.request_mode === 'urgent' ? 'ASAP' : formatDateTime(j.scheduled_for)}{j.my_quote_status ? ` · quote ${j.my_quote_status}` : ''}</div>
        </a>
      ))}
      <h2>My quotes</h2>
      {(quotes.data ?? []).slice(0, 15).map((q: any) => <div key={q.id} className="card row spread"><span>{q.title} <span className="faint">{q.category_name}</span></span><span>{formatMoney(q.amount, q.currency_code)} · <span className="pill">{q.status}</span></span></div>)}
      <h2>Booked</h2>
      {(bookings.data?.items ?? []).map(b => <div key={b.id} className="card row spread"><span>{b.title} <span className="faint">{b.reference}</span></span><span className={`pill ${BOOKING_STATUS[b.status].tone}`}>{BOOKING_STATUS[b.status].provider}</span></div>)}
    </div>
  );
}

export default function Page() { return <main className="container" style={{ padding: '32px 20px' }}><RequireAuth role="provider"><ProPortal /></RequireAuth></main>; }
