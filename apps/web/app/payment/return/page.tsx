'use client';
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/client';

/** Landing page after the hosted payment page. The booking only becomes "paid" from the server-side signed callback; we poll /verify. */
export default function PaymentReturn() {
  const { api, ready } = useSession();
  const [state, setState] = useState<'checking' | 'ok' | 'failed' | 'pending'>('checking');
  useEffect(() => {
    if (!ready) return;
    const q = new URLSearchParams(window.location.search);
    const paymentId = q.get('paymentId'); const bookingId = q.get('bookingId');
    if (!paymentId) { setState('pending'); return; }
    let n = 0;
    const tick = async () => {
      n++;
      try {
        const v = await api.bookings.verifyPayment(paymentId);
        if (v.status === 'captured' || ['assigned', 'payment_authorized'].includes(v.booking_status)) { setState('ok'); setTimeout(() => (window.location.href = `/bookings/${bookingId ?? ''}`), 1200); return; }
        if (v.status === 'failed') { setState('failed'); return; }
      } catch { /* retry */ }
      if (n < 20) setTimeout(tick, 1500); else setState('pending');
    };
    tick();
  }, [ready, api]);
  return (
    <main className="container" style={{ maxWidth: 520, padding: '64px 20px', textAlign: 'center' }}>
      {state === 'checking' ? <p>Confirming your payment…</p> : null}
      {state === 'ok' ? <div className="banner success">Payment confirmed. Your pro has been notified.</div> : null}
      {state === 'failed' ? <div className="banner danger">The payment didn't go through. <a href="javascript:history.back()">Try again</a></div> : null}
      {state === 'pending' ? <div className="banner warning">We haven't received confirmation yet. If you were charged, your booking will update automatically within a few minutes.</div> : null}
    </main>
  );
}
