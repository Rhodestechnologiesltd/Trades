import { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import MapView, { Circle } from 'react-native-maps';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatDistance, formatMoney, previewProviderNet, timeUntil } from '@trades/shared';
import {
  Banner, Body, Button, Card, Caption, ConfirmSheet, H2, Input, KeyValue, Loading, Muted, Pill, Row, Screen, Sheet, Spacer, Stars, colors, errorMessage,
  normalizeAmount, radius, useApi,
} from '@trades/mobile-ui';
import { usePublicConfig, useProviderMe } from '../../../src/hooks';

export default function JobRequest() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const pc = usePublicConfig();
  const me = useProviderMe().data;
  const q = useQuery({ queryKey: ['request', id], queryFn: () => api.requests.get(id), refetchInterval: 15_000 });
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [eta, setEta] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterAmt, setCounterAmt] = useState('');
  const [declineOpen, setDeclineOpen] = useState(false);
  const [instantOpen, setInstantOpen] = useState(false);
  const r = q.data;

  useEffect(() => { if (r?.bookingStatus && r.bookingId && r.myQuote?.status === 'accepted') router.replace(`/booking/${r.bookingId}`); }, [r?.bookingId, r?.bookingStatus, r?.myQuote?.status]);
  if (!r) return q.isError ? <Screen><Banner tone="danger" title="This job is no longer available" /></Screen> : <Loading />;

  const refresh = () => { qc.invalidateQueries({ queryKey: ['request', id] }); qc.invalidateQueries({ queryKey: ['jobs'] }); qc.invalidateQueries({ queryKey: ['my-quotes'] }); };
  const mine = r.myQuote;
  const rounds = mine?.counterOffers ?? [];
  const openCounter = rounds.find(c => c.status === 'proposed' && c.proposed_by === 'customer');
  const quotable = ['dispatched', 'quoted'].includes(r.status) && (!mine || ['withdrawn', 'expired'].includes(mine.status));
  const preview = normalizeAmount(amount) ? previewProviderNet(normalizeAmount(amount)!, pc.providerCommissionPct) : null;
  const instantPrice = r.mode === 'urgent' && r.instantAcceptPrice && me?.instant_accept_enabled ? r.instantAcceptPrice : null;

  async function submitQuote() {
    const a = normalizeAmount(amount);
    if (!a) return setError('Enter your price');
    setBusy(true); setError(null);
    try {
      const minutes = Number(eta);
      await api.quotes.submit({ requestId: r!.id, amount: a, message: message.trim() || undefined, estimatedStartAt: minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : r!.scheduledFor ?? undefined });
      refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function respond(action: 'accept' | 'reject' | 'counter') {
    if (!openCounter) return;
    setBusy(true);
    try {
      const amt = action === 'counter' ? normalizeAmount(counterAmt) : undefined;
      if (action === 'counter' && !amt) { setBusy(false); return Alert.alert('Enter a valid amount'); }
      const res = await api.quotes.respond(openCounter.id, action, amt ?? undefined);
      setCounterOpen(false);
      if (res.bookingId) router.replace(`/booking/${res.bookingId}`); else refresh();
    } catch (e) { Alert.alert('Error', errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Row justify="space-between"><H2>{r.title}</H2>{r.mode === 'urgent' ? <Pill label="URGENT" tone="danger" icon="flash" /> : null}</Row>
      <Muted>{r.category.name} · {r.mode === 'urgent' ? 'As soon as possible' : formatDateTime(r.scheduledFor)}</Muted>
      {r.dispatch?.responseDeadline && !mine ? <Text style={{ color: colors.urgent, fontWeight: '600', marginTop: 4 }}>Respond within {timeUntil(r.dispatch.responseDeadline)}</Text> : null}
      <Spacer h={3} />
      <View style={styles.map}>
        <MapView style={StyleSheet.absoluteFill} region={{ latitude: r.location.lat, longitude: r.location.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }} scrollEnabled={false} zoomEnabled={false}>
          <Circle center={{ latitude: r.location.lat, longitude: r.location.lng }} radius={r.location.precision === 'exact' ? 60 : 400} strokeColor={colors.brand} fillColor="rgba(14,124,102,0.15)" />
        </MapView>
      </View>
      <Muted>{r.location.areaLabel ?? 'Nearby'} · {formatDistance(r.distanceM)} away (~{r.etaMin} min){r.location.precision === 'approximate' ? ' · exact address after booking' : ''}</Muted>
      <Spacer h={3} />
      <Card>
        <Body>{r.description}</Body>
        {r.photos.length ? <ScrollView horizontal style={{ marginTop: 8 }}>{r.photos.map(u => <Image key={u} source={{ uri: u }} style={{ width: 96, height: 96, borderRadius: radius.md, marginRight: 8 }} />)}</ScrollView> : null}
        <Spacer h={2} />
        <Row gap={2}>
          <Muted>Customer: {r.customer.firstName}</Muted>
          {r.customer.rating ? <><Stars value={Number(r.customer.rating)} size={12} /><Muted>({r.customer.ratingCount})</Muted></> : <Muted>· new customer</Muted>}
        </Row>
        {r.budgetHint ? <Muted>Customer budget: {formatMoney(r.budgetHint, r.currency)}</Muted> : null}
      </Card>

      {instantPrice && quotable ? (
        <Card tone="urgent">
          <Caption>Fixed-price call-out</Caption>
          <Body style={{ fontWeight: '700', fontSize: 18 }}>{formatMoney(instantPrice, r.currency)}</Body>
          <Muted>Accept now and the job is yours instantly — first come, first served. You receive {formatMoney(previewProviderNet(instantPrice, pc.providerCommissionPct).net, r.currency)} after commission.</Muted>
          <Spacer h={2} />
          <Button title="Accept instantly" variant="urgent" icon="flash" onPress={() => setInstantOpen(true)} />
        </Card>
      ) : null}

      {mine && !['withdrawn', 'expired'].includes(mine.status) ? (
        <Card tone="brand">
          <Row justify="space-between"><Caption>Your quote</Caption><Pill label={mine.status} tone={mine.status === 'accepted' ? 'success' : mine.status === 'countered' ? 'warning' : 'info'} /></Row>
          <Body style={{ fontWeight: '700', fontSize: 18 }}>{formatMoney(mine.amount, r.currency)}</Body>
          {rounds.map(c => (
            <Row key={c.id} justify="space-between">
              <Muted>{c.proposed_by === 'customer' ? 'Customer offered' : 'You countered'} (round {c.round_number}) · {c.status}</Muted>
              <Text style={{ fontWeight: '600' }}>{formatMoney(c.amount, c.currency_code)}</Text>
            </Row>
          ))}
          {openCounter ? (
            <>
              <Spacer h={3} />
              <Banner tone="warning" title={`Customer offers ${formatMoney(openCounter.amount, r.currency)}`} body={openCounter.message ?? `You'd receive ${formatMoney(previewProviderNet(openCounter.amount, pc.providerCommissionPct).net, r.currency)} after commission.`} />
              <Button title={`Accept ${formatMoney(openCounter.amount, r.currency)}`} onPress={() => respond('accept')} loading={busy} />
              <Spacer h={2} />
              <Row gap={2}>
                <Button style={{ flex: 1 }} small variant="secondary" title="Counter" onPress={() => setCounterOpen(true)} />
                <Button style={{ flex: 1 }} small variant="danger" title="Decline" onPress={() => respond('reject')} />
              </Row>
            </>
          ) : mine.status === 'active' ? (
            <>
              <Spacer h={2} />
              <Muted>Waiting for the customer. Valid until {formatDateTime(mine.valid_until)}.</Muted>
              <Button small variant="ghost" title="Withdraw quote" onPress={async () => { await api.quotes.withdraw(mine.id); refresh(); }} />
            </>
          ) : null}
          <Button small variant="ghost" icon="chatbubble-ellipses-outline" title="Message customer" onPress={() => router.push({ pathname: '/request/[id]/chat', params: { id: r.id } })} />
        </Card>
      ) : null}

      {quotable ? (
        <Card>
          <H2>Send a quote</H2>
          <Spacer h={3} />
          {error ? <Banner tone="danger" title={error} /> : null}
          <Input label="Your price (total for the job)" prefix={r.currency} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
          {preview ? (
            <View style={{ marginTop: -8, marginBottom: 12 }}>
              <KeyValue k={`Commission (${pc.providerCommissionPct}%)`} v={`− ${formatMoney(preview.commission, r.currency)}`} />
              <KeyValue k="You receive" v={formatMoney(preview.net, r.currency)} strong />
            </View>
          ) : null}
          {r.mode === 'urgent' ? <Input label="I can arrive in (minutes)" keyboardType="number-pad" value={eta} onChangeText={setEta} placeholder="e.g. 25" /> : null}
          <Input label="Message to customer (optional)" multiline value={message} onChangeText={setMessage} placeholder="What's included, materials, questions…" />
          <Button title="Send quote" onPress={submitQuote} loading={busy} />
          <Spacer h={2} />
          <Button title="Not for me" variant="ghost" onPress={() => setDeclineOpen(true)} />
        </Card>
      ) : null}
      {!quotable && !mine ? <Banner tone="neutral" title="This request is no longer taking quotes" /> : null}

      <Sheet visible={counterOpen} onClose={() => setCounterOpen(false)} title="Counter-offer">
        <Input label="Your price" prefix={r.currency} keyboardType="decimal-pad" value={counterAmt} onChangeText={setCounterAmt} autoFocus />
        <Button title="Send counter-offer" onPress={() => respond('counter')} loading={busy} />
      </Sheet>
      <ConfirmSheet visible={declineOpen} onClose={() => setDeclineOpen(false)} title="Decline this job?" confirmLabel="Decline"
        body={r.mode === 'urgent' ? "No problem — declining urgent jobs doesn't affect your ranking." : "We'll offer it to other pros."}
        onConfirm={async () => { await api.dispatch.decline(r.id).catch(() => undefined); setDeclineOpen(false); router.back(); }} />
      <ConfirmSheet visible={instantOpen} onClose={() => setInstantOpen(false)} title="Take this job now?" confirmLabel="Yes, I'm on my way" loading={busy}
        body="You commit to go straight to the customer once they've paid. Not showing up counts as a no-show."
        onConfirm={async () => {
          setBusy(true);
          try { const res = await api.quotes.instantAccept(r.id); setInstantOpen(false); router.replace(`/booking/${res.bookingId}`); }
          catch (e) { setInstantOpen(false); Alert.alert('Too late', errorMessage(e)); refresh(); } finally { setBusy(false); }
        }} />
    </Screen>
  );
}

const styles = StyleSheet.create({ map: { height: 170, borderRadius: radius.lg, overflow: 'hidden', marginBottom: 6 } });
