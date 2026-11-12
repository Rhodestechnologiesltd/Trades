import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useQueryClient } from '@tanstack/react-query';
import { PaymentInit, formatMoney } from '@trades/shared';
import { Banner, Body, Button, Card, H2, KeyValue, Loading, Muted, Screen, Spacer, errorMessage, useApi } from '@trades/mobile-ui';

const RETURN_URL = 'trades://payment-return';

/**
 * Card entry happens ONLY on the gateway's hosted page (MIPS) inside a WebView — card data never
 * touches our app or servers (PCI SAQ-A, §J). The booking becomes "paid" only from the server-side
 * signed callback; the app polls /verify as a fallback for webhook delay.
 */
export default function Pay() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [init, setInit] = useState<PaymentInit | null>(null);
  const [phase, setPhase] = useState<'summary' | 'paying' | 'verifying' | 'failed'>('summary');
  const [error, setError] = useState<string | null>(null);
  const polls = useRef(0);

  useEffect(() => {
    api.bookings.pay(id, RETURN_URL).then(setInit).catch(e => setError(errorMessage(e)));
  }, [api, id]);

  async function verify() {
    if (!init) return;
    setPhase('verifying');
    polls.current = 0;
    const tick = async () => {
      polls.current++;
      try {
        const v = await api.bookings.verifyPayment(init.paymentId);
        if (v.status === 'captured' || ['assigned', 'payment_authorized'].includes(v.booking_status)) {
          qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] });
          router.replace(`/booking/${id}`);
          return;
        }
        if (v.status === 'failed') { setPhase('failed'); setError(v.failure_code === 'card_declined' ? 'Your card was declined.' : 'The payment did not go through.'); return; }
      } catch { /* keep polling */ }
      if (polls.current < 20) setTimeout(tick, 1500); else { setPhase('failed'); setError("We haven't received confirmation yet. If you were charged, your booking will update automatically."); }
    };
    tick();
  }

  if (error && phase !== 'failed') return <Screen><Banner tone="danger" title="Payment unavailable" body={error} /><Button title="Back" onPress={() => router.back()} /></Screen>;
  if (!init) return <Loading label="Preparing secure payment…" />;

  if (phase === 'paying') {
    return (
      <View style={{ flex: 1 }}>
        <WebView
          source={{ uri: init.redirectUrl }} startInLoadingState originWhitelist={['https://*', 'http://*', 'trades://*']}
          onShouldStartLoadWithRequest={req => {
            if (req.url.startsWith(RETURN_URL) || req.url.includes('/v1/payments/return')) { verify(); return false; }
            return true;
          }}
        />
      </View>
    );
  }
  if (phase === 'verifying') return <Loading label="Confirming your payment…" />;

  return (
    <Screen footer={<Button title={phase === 'failed' ? 'Try again' : `Pay ${formatMoney(init.breakdown.total, init.breakdown.currency)}`} icon="lock-closed"
      onPress={async () => {
        if (phase === 'failed') {
          setError(null);
          try { setInit(await api.bookings.pay(id, RETURN_URL)); } catch (e) { setError(errorMessage(e)); return; }
        }
        setPhase('paying');
      }} />}>
      <H2>Confirm & pay</H2>
      <Spacer h={3} />
      {phase === 'failed' && error ? <Banner tone="danger" title="Payment failed" body={error} /> : null}
      <Card>
        <KeyValue k="Job price" v={formatMoney(init.breakdown.agreedAmount, init.breakdown.currency)} />
        <KeyValue k={`Service fee (${init.breakdown.feePct}%)`} v={formatMoney(init.breakdown.platformFee, init.breakdown.currency)} />
        <KeyValue k="Total" v={formatMoney(init.breakdown.total, init.breakdown.currency)} strong />
      </Card>
      <Banner tone="success" icon="shield-checkmark" title="Protected payment" body="We hold your payment and only pay your pro after you approve the work. Problems? Report them and we'll step in." />
      <Body>You'll enter your card on the secure MIPS payment page.</Body>
      <Muted>Visa and Mastercard accepted. 3-D Secure may ask you to confirm with your bank.</Muted>
    </Screen>
  );
}
