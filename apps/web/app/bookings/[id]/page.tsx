'use client';
import { use, useState } from 'react';
import { BOOKING_STATUS, DISPUTE_REASONS, DisputeReason, formatDateTime, formatMoney, timeUntil } from '@trades/shared';
import { RequireAuth, msg, useAsync, useSession } from '../../../src/client';

function BookingView({ id }: { id: string }) {
  const { api } = useSession();
  const { data: b, error, reload } = useAsync(() => api.bookings.get(id), [id], { pollMs: 20_000 });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState<DisputeReason>('incomplete_work');
  const [desc, setDesc] = useState('');
  if (error) return <div className="banner danger">{error}</div>;
  if (!b) return <p className="muted">Loading…</p>;
  const act = (fn: () => Promise<any>, ok?: string) => async () => { setBusy(true); setNote(null); try { await fn(); if (ok) setNote(ok); reload(); } catch (e) { setNote(msg(e)); } finally { setBusy(false); } };
  const s = BOOKING_STATUS[b.status];
  const cur = b.pricing.total?.currency ?? 'MUR';

  async function pay() {
    setBusy(true);
    try {
      const p = await api.bookings.pay(b!.id, `${window.location.origin}/payment/return?bookingId=${b!.id}`);
      window.location.href = p.redirectUrl; // hosted MIPS page — card data never touches our servers
    } catch (e) { setNote(msg(e)); setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>{b.title}</h1><span className={`pill ${s.tone}`}>{s.customer}</span></div>
      <p className="muted" style={{ margin: 0 }}>{b.category.name} · Ref {b.reference} · {b.scheduledStartAt ? formatDateTime(b.scheduledStartAt) : 'As soon as possible'}</p>
      {note ? <div className="banner">{note}</div> : null}
      {b.status === 'payment_pending' ? <div className="banner warning">Pay within {timeUntil(b.paymentDueAt)} to confirm your pro.</div> : null}
      <div className="grid two">
        <div className="card stack">
          <strong>{b.provider.name}</strong>
          <div className="faint">{b.provider.rating ? `★ ${b.provider.rating}` : 'New pro'}{b.provider.phone ? ` · ${b.provider.phone}` : ''}</div>
          <div className="faint">{b.location.addressText ?? b.location.areaLabel}</div>
        </div>
        <div className="card kv">
          <span>Job price</span><span>{formatMoney(b.pricing.agreed?.amount, cur)}</span>
          <span>Service fee ({b.pricing.feePct}%)</span><span>{formatMoney(b.pricing.platformFee?.amount, cur)}</span>
          <span className="total">Total</span><span className="total">{formatMoney(b.pricing.total?.amount, cur)}</span>
        </div>
      </div>
      {b.status === 'payment_pending' ? <button className="btn block" disabled={busy} onClick={pay}>🔒 Pay {formatMoney(b.pricing.total?.amount, cur)} securely</button> : null}
      {b.status === 'completed_by_provider' ? (
        <div className="card stack">
          <strong>Is the job done?</strong>
          {b.completionNotes ? <p className="muted" style={{ margin: 0 }}>{b.completionNotes}</p> : null}
          <div className="row">{b.photos.map(u => <img key={u} src={u} alt="Completed work" style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 8 }} />)}</div>
          <button className="btn" disabled={busy} onClick={act(() => api.bookings.approve(b.id), 'Approved — thank you!')}>Approve & release payment</button>
          {b.autoApproveAt ? <span className="faint">Auto-approves in {timeUntil(b.autoApproveAt)} unless you report a problem.</span> : null}
        </div>
      ) : null}
      {['completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released', 'in_progress'].includes(b.status) && !b.dispute && (!b.disputeDeadlineAt || new Date(b.disputeDeadlineAt) > new Date()) ? (
        <details className="card"><summary>Report a problem</summary>
          <label>What went wrong?</label>
          <select value={reason} onChange={e => setReason(e.target.value as DisputeReason)}>{(Object.keys(DISPUTE_REASONS) as DisputeReason[]).filter(r => r !== 'no_show').map(r => <option key={r} value={r}>{DISPUTE_REASONS[r]}</option>)}</select>
          <label>Details</label><textarea value={desc} onChange={e => setDesc(e.target.value)} />
          <div style={{ height: 10 }} />
          <button className="btn secondary" disabled={busy || desc.length < 10} onClick={act(() => api.disputes.open({ bookingId: b.id, reasonCode: reason, description: desc }), 'Reported — our team will review it. Payment to the pro is on hold.')}>Submit</button>
        </details>
      ) : null}
      {b.dispute ? <div className="banner warning">Dispute {b.dispute.status.replace('_', ' ')}{b.dispute.resolution ? ` — ${b.dispute.resolution.replace(/_/g, ' ')}` : ''}. Our support team will contact you.</div> : null}
      {['approved_by_customer', 'payout_pending', 'payout_released'].includes(b.status) && !b.myReview ? (
        <div className="card stack">
          <strong>Rate {b.provider.name}</strong>
          <div className="row">{[1, 2, 3, 4, 5].map(n => <button key={n} className={`btn ${rating >= n ? '' : 'secondary'}`} style={{ padding: '6px 12px' }} onClick={() => setRating(n)} aria-label={`${n} stars`}>★</button>)}</div>
          <textarea placeholder="Optional comment" value={comment} onChange={e => setComment(e.target.value)} />
          <button className="btn" disabled={busy} onClick={act(() => api.reviews.create({ bookingId: b.id, rating, comment: comment || undefined }), 'Thanks for your review!')}>Submit review</button>
        </div>
      ) : null}
      {b.availableActions.includes('cancel') ? <button className="btn ghost" disabled={busy} onClick={act(() => api.bookings.cancel(b.id, 'Cancelled on web'), 'Booking cancelled')}>Cancel booking</button> : null}
      <div className="card"><strong>Timeline</strong>{b.timeline.map((t, i) => <div key={i} className="faint">{formatDateTime(t.occurred_at)} — {t.to_state.replace(/_/g, ' ')}</div>)}</div>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <main className="container" style={{ maxWidth: 760, padding: '32px 20px' }}><RequireAuth><BookingView id={id} /></RequireAuth></main>;
}
