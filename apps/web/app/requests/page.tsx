'use client';
import { BOOKING_STATUS, REQUEST_STATUS, formatDateTime, formatMoney } from '@trades/shared';
import { RequireAuth, useAsync, useSession } from '../../src/client';

function MyJobs() {
  const { api } = useSession();
  const reqs = useAsync(() => api.requests.list(), []);
  const active = useAsync(() => api.bookings.history({ status: 'active' }), []);
  const past = useAsync(() => api.bookings.history({ status: 'past' }), []);
  const open = (reqs.data?.items ?? []).filter(r => !r.booking_id && ['requested', 'matching', 'dispatched', 'quoted'].includes(r.status));
  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>My jobs</h1><a className="btn" href="/request/new">New request</a></div>
      <h2>Open requests</h2>
      {!open.length ? <p className="muted">No open requests.</p> : open.map(r => (
        <a key={r.id} className="card link row spread" href={`/requests/${r.id}`}>
          <div><strong>{r.title}</strong><div className="faint">{r.category_name} · {r.request_mode === 'urgent' ? 'Urgent' : formatDateTime(r.scheduled_for)}</div></div>
          <div className="row"><span className={`pill ${REQUEST_STATUS[r.status].tone}`}>{REQUEST_STATUS[r.status].label}</span>{r.best_quote ? <span>from {formatMoney(r.best_quote, r.currency_code)}</span> : null}</div>
        </a>
      ))}
      <h2>Bookings</h2>
      {[...(active.data?.items ?? []), ...(past.data?.items ?? [])].map(b => (
        <a key={b.id} className="card link row spread" href={`/bookings/${b.id}`}>
          <div><strong>{b.title}</strong><div className="faint">{b.counterparty_name} · {b.reference} · {formatDateTime(b.scheduled_start_at ?? b.created_at)}</div></div>
          <div className="row"><span className={`pill ${BOOKING_STATUS[b.status].tone}`}>{BOOKING_STATUS[b.status].customer}</span><span>{formatMoney(b.agreed_amount, b.currency_code)}</span></div>
        </a>
      ))}
    </div>
  );
}

export default function Page() { return <main className="container" style={{ padding: '32px 20px' }}><RequireAuth><MyJobs /></RequireAuth></main>; }
