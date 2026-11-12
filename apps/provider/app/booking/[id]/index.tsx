import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import MapView, { Marker } from 'react-native-maps';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney, timeUntil } from '@trades/shared';
import {
  Banner, Body, BookingStatusPill, Button, Card, Caption, Divider, H2, H3, Input, KeyValue, Loading, Muted, Row, Screen, Sheet, Spacer, Timeline, colors,
  errorMessage, radius, useApi,
} from '@trades/mobile-ui';
import { currentPosition, startTracking } from '../../../src/location';

export default function Job() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => api.bookings.get(id), refetchInterval: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const b = q.data;

  useEffect(() => { if (b && ['assigned', 'in_progress'].includes(b.status)) startTracking('job', b.id).catch(() => undefined); }, [b?.status, b?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b) return <Loading />;

  const refresh = () => { qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] }); };
  async function act(key: string, fn: () => Promise<any>, after?: (r: any) => void) {
    setBusy(key);
    try { const r = await fn(); refresh(); after?.(r); } catch (e) { Alert.alert('Something went wrong', errorMessage(e)); } finally { setBusy(null); }
  }
  const navigate = () => {
    const { lat, lng } = b.location;
    const url = Platform.OS === 'ios' ? `maps://?daddr=${lat},${lng}` : `google.navigation:q=${lat},${lng}`;
    Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`));
  };
  const enRoute = b.jobEvents.some(e => e.event_type === 'en_route');
  const arrived = b.jobEvents.some(e => e.event_type === 'arrived');
  const completed = ['completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released'].includes(b.status);

  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Row justify="space-between"><H2>{b.title}</H2><BookingStatusPill status={b.status} audience="provider" /></Row>
      <Muted>{b.category.name} · {b.reference}</Muted>
      <Spacer h={3} />
      {b.status === 'payment_pending' ? <Banner tone="warning" title="Waiting for the customer to pay" body={`Don't set off yet — you'll be notified when payment is confirmed (within ${timeUntil(b.paymentDueAt)}).`} /> : null}
      {b.status === 'completed_by_provider' ? <Banner tone="info" title="Waiting for customer approval" body={b.autoApproveAt ? `Auto-approves in ${timeUntil(b.autoApproveAt)} if the customer doesn't respond.` : undefined} /> : null}
      {b.payout ? (
        <Banner tone={b.payout.status === 'held' ? 'warning' : 'success'} title={b.payout.released_at ? `Paid ${formatMoney(b.payout.net_payout_amount, b.pricing.payout?.currency)}` : b.payout.status === 'held' ? 'Payout on hold' : `Payout scheduled ${formatDateTime(b.payout.eligible_at)}`}
          body={b.payout.hold_reason ?? undefined} />
      ) : null}
      {b.status === 'disputed' ? <Banner tone="danger" title="The customer reported a problem" body="Your payout is on hold. Reply in the dispute with your side and any photos." /> : null}

      <Card>
        <View style={styles.map}>
          <MapView style={StyleSheet.absoluteFill} region={{ latitude: b.location.lat, longitude: b.location.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }}>
            <Marker coordinate={{ latitude: b.location.lat, longitude: b.location.lng }} pinColor={colors.brand} />
          </MapView>
        </View>
        {b.location.precision === 'exact' ? (
          <>
            <Body style={{ fontWeight: '600' }}>{b.location.addressText ?? 'Pinned location'}</Body>
            {b.location.accessNotes ? <Muted>Access: {b.location.accessNotes}</Muted> : null}
            <Spacer h={2} />
            <Row gap={2}>
              <Button style={{ flex: 1 }} small icon="navigate" title="Navigate" onPress={navigate} />
              {b.customer.phone ? <Button style={{ flex: 1 }} small variant="secondary" icon="call" title={`Call ${b.customer.name}`} onPress={() => Linking.openURL(`tel:${b.customer.phone}`)} /> : null}
            </Row>
          </>
        ) : <Muted>Exact address appears once the customer has paid.</Muted>}
      </Card>

      <Card>
        <Caption>Job</Caption>
        <Body>{b.description}</Body>
        <Spacer h={2} />
        <KeyValue k="When" v={b.scheduledStartAt ? formatDateTime(b.scheduledStartAt) : 'As soon as possible'} />
        <Divider />
        <KeyValue k="Agreed price" v={formatMoney(b.pricing.agreed?.amount, b.pricing.agreed?.currency)} />
        <KeyValue k={`Commission (${b.pricing.commissionPct}%)`} v={`− ${formatMoney(b.pricing.commission?.amount, b.pricing.commission?.currency)}`} />
        <KeyValue k="You receive" v={formatMoney(b.pricing.payout?.amount, b.pricing.payout?.currency)} strong />
      </Card>

      {b.status === 'assigned' ? (
        <>
          {!enRoute ? <Button title="I'm on my way" icon="car" variant="secondary" loading={busy === 'enroute'} onPress={() => act('enroute', async () => {
            const pos = await currentPosition();
            return api.bookings.jobEvent(b.id, { type: 'en_route', lat: pos?.lat, lng: pos?.lng });
          })} /> : null}
          {enRoute && !arrived ? <><Spacer h={2} /><Button title="I've arrived" icon="location" variant="secondary" loading={busy === 'arrived'} onPress={() => act('arrived', async () => {
            const pos = await currentPosition();
            return api.bookings.jobEvent(b.id, { type: 'arrived', lat: pos?.lat, lng: pos?.lng });
          })} /></> : null}
          <Spacer h={2} />
          <Button title="Start job" icon="play" loading={busy === 'start'} onPress={() => act('start', async () => api.bookings.start(b.id, (await currentPosition()) ?? undefined), (r: any) => {
            if (r?.withinGeofence === false) Alert.alert('Started', "You seem to be away from the job address. That's fine if the job is elsewhere — it's noted for the customer.");
          })} />
        </>
      ) : null}
      {b.status === 'in_progress' ? <Button title="Mark job complete" icon="checkmark-done" onPress={() => router.push({ pathname: '/booking/[id]/complete', params: { id: b.id } })} /> : null}
      {completed && !b.myReview ? <><Spacer h={2} /><Button title="Rate the customer" icon="star" variant="secondary" onPress={() => router.push({ pathname: '/booking/[id]/review', params: { id: b.id } })} /></> : null}
      {b.dispute ? <><Spacer h={2} /><Button title="Open dispute" variant="secondary" onPress={() => router.push(`/dispute/${b.dispute!.id}`)} /></> : null}
      {['completed_by_provider', 'approved_by_customer', 'payout_pending'].includes(b.status) && !b.dispute ? (
        <><Spacer h={2} /><Button title="Report a problem with the customer" variant="ghost" onPress={() => router.push({ pathname: '/booking/[id]/problem', params: { id: b.id } })} /></>
      ) : null}
      <Spacer h={2} />
      <Button title="Message customer" variant="ghost" icon="chatbubble-ellipses-outline" onPress={() => router.push({ pathname: '/request/[id]/chat', params: { id: b.requestId } })} />
      {['payment_authorized', 'assigned'].includes(b.status) ? <Button title="I can't do this job" variant="ghost" onPress={() => setCancelOpen(true)} /> : null}

      <Spacer h={6} />
      <H3>Timeline</H3>
      <Spacer h={3} />
      <Timeline events={b.timeline} />

      <Sheet visible={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this job?">
        <Banner tone="warning" title="This counts against your reliability" body="The customer is refunded in full and we find them another pro. Repeated cancellations lower your ranking and can lead to suspension." />
        <Input label="Reason" value={reason} onChangeText={setReason} placeholder="e.g. Van broke down" />
        <Button title="Cancel job" variant="danger" loading={busy === 'cancel'} onPress={() => act('cancel', () => api.bookings.cancel(b.id, reason || 'Provider cancelled'), () => setCancelOpen(false))} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({ map: { height: 160, borderRadius: radius.md, overflow: 'hidden', marginBottom: 10 } });
