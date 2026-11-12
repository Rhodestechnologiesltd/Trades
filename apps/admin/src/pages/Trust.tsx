import { useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, Pill, useAction, useApi, useData, useSession } from '../lib';

export function Trust() {
  const api = useApi();
  const { role } = useSession();
  const [tab, setTab] = useState<'fraud' | 'reviews' | 'notifications'>('fraud');
  const [status, setStatus] = useState('open');
  const fraud = useData(() => (tab === 'fraud' ? api.admin.fraudSignals(status) : Promise.resolve([])), [tab, status]);
  const reviews = useData(() => (tab === 'reviews' ? api.admin.flaggedReviews() : Promise.resolve([])), [tab]);
  const notif = useData(() => (tab === 'notifications' ? api.admin.failedNotifications() : Promise.resolve([])), [tab]);
  const act = useAction();
  return (
    <>
      <div className="topbar"><div><h1>Trust & safety</h1><span className="muted">Spoofing, quote spam, fake completions, collusion, card testing, chargebacks (§J)</span></div></div>
      <div className="tabs">{(['fraud', 'reviews', 'notifications'] as const).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'fraud' ? 'Fraud signals' : t === 'reviews' ? 'Review moderation' : 'Undelivered notifications'}</button>)}</div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {tab === 'fraud' ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>{['open', 'reviewing', 'actioned', 'dismissed'].map(s => <button key={s} className={`small ${status === s ? '' : 'secondary'}`} onClick={() => setStatus(s)}>{s}</button>)}</div>
          {fraud.loading ? <Loading /> : (
            <table>
              <thead><tr><th>Signal</th><th>Severity</th><th>Subject</th><th>Details</th><th>Booking</th><th>When</th><th></th></tr></thead>
              <tbody>{fraud.data?.map((f: any) => (
                <tr key={f.id}>
                  <td><strong>{f.signal.replace(/_/g, ' ')}</strong></td><td><Pill tone={f.severity >= 4 ? 'danger' : f.severity >= 3 ? 'warning' : 'neutral'}>{f.severity}</Pill></td>
                  <td>{f.user_type === 'provider' ? <a href={`#/providers/${f.subject_user_id}`}>{f.full_name}</a> : f.full_name} <span className="faint">{f.user_type}</span></td>
                  <td className="mono" style={{ maxWidth: 360, wordBreak: 'break-all' }}>{JSON.stringify(f.details)}</td>
                  <td>{f.booking_id ? <a href={`#/bookings/${f.booking_id}`}>open</a> : '—'}</td><td className="faint">{formatDateTime(f.created_at)}</td>
                  <td className="row">{['reviewing', 'actioned', 'dismissed'].filter(s => s !== f.status).map(s => <button key={s} className="small secondary" onClick={() => act.run(() => api.admin.updateFraudSignal(f.id, s)).then(fraud.reload)}>{s}</button>)}</td>
                </tr>
              ))}{!fraud.data?.length ? <tr><td colSpan={7} className="muted">No signals.</td></tr> : null}</tbody>
            </table>
          )}
        </div>
      ) : null}
      {tab === 'reviews' ? (
        <div className="card">
          {reviews.loading ? <Loading /> : (
            <table>
              <thead><tr><th>Rating</th><th>Comment (moderated)</th><th>Original</th><th>Flags</th><th>By</th><th></th></tr></thead>
              <tbody>{reviews.data?.map((r: any) => (
                <tr key={r.id}><td>{'★'.repeat(r.rating)}</td><td>{r.comment}</td><td className="faint">{r.comment_original ?? '—'}</td><td>{r.moderation_flags.map((f: string) => <Pill key={f} tone="warning">{f}</Pill>)}{r.is_hidden ? <Pill tone="danger">hidden</Pill> : null}</td><td>{r.reviewer_name}</td>
                  <td>{role === 'admin' ? <button className="small secondary" onClick={() => { const reason = prompt('Reason (audit-logged)'); if (reason) act.run(() => api.admin.setReviewVisibility(r.id, !r.is_hidden, reason)).then(reviews.reload); }}>{r.is_hidden ? 'Unhide' : 'Hide'}</button> : null}</td></tr>
              ))}{!reviews.data?.length ? <tr><td colSpan={6} className="muted">Nothing flagged.</td></tr> : null}</tbody>
            </table>
          )}
        </div>
      ) : null}
      {tab === 'notifications' ? (
        <div className="card">
          {notif.loading ? <Loading /> : (
            <table>
              <thead><tr><th>Recipient</th><th>Channel</th><th>Event</th><th>Error</th><th className="num">Attempts</th><th>Created</th><th></th></tr></thead>
              <tbody>{notif.data?.map((n: any) => (
                <tr key={n.id}><td>{n.full_name}</td><td>{n.channel}</td><td className="mono">{n.event_type}</td><td>{n.last_error}</td><td className="num">{n.attempts}</td><td className="faint">{formatDateTime(n.created_at)}</td>
                  <td><button className="small secondary" onClick={() => act.run(() => api.admin.retryNotification(n.id), 'Re-queued').then(notif.reload)}>Retry</button></td></tr>
              ))}{!notif.data?.length ? <tr><td colSpan={7} className="muted">All notifications delivered.</td></tr> : null}</tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}
