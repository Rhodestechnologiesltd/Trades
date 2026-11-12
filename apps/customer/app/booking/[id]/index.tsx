import { useEffect, useState } from 'react';
import { Alert, Image, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import MapView, { Marker } from 'react-native-maps';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney, timeUntil } from '@trades/shared';
import {
  Avatar, Banner, Body, BookingStatusPill, Button, Card, Caption, ConfirmSheet, Divider, H2, H3, Input, KeyValue, Loading, Muted, Row, Screen, Sheet,
  Spacer, Stars, Timeline, colors, errorMessage, radius, subscribeBooking, useApi,
} from '@trades/mobile-ui';
import { usePublicConfig } from '../../../src/hooks';

export default function BookingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const pc = usePublicConfig();
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => api.bookings.get(id), refetchInterval: 20_000 });
  const tracking = useQuery({
    queryKey: ['booking', id, 'tracking'], queryFn: () => api.bookings.tracking(id), refetchInterval: 15_000,
    enabled: ['assigned', 'in_progress'].includes(q.data?.status ?? ''),
  });
  const [confirm, setConfirm] = useState<'approve' | 'cancel' | 'noshow' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { subscribeBooking(id); }, [id]);
  const b = q.data;
  if (q.isLoading || !b) return <Loading />;

  const refresh = () => { qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] }); };
  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); setConfirm(null); refresh(); if (done) Alert.alert(done); } catch (e) { Alert.alert('Something went wrong', errorMessage(e)); } finally { setBusy(false); }
  }
  const can = (t: string) => b.availableActions.includes(t);
  const completed = ['approved_by_customer', 'payout_pending', 'payout_released'].includes(b.status);
  const reviewable = (completed || b.status === 'completed_by_provider') && !b.myReview;
  const canDispute = ['in_progress', 'completed_by_provider', 'approved_by_customer', 'payout_pending', 'payout_released'].includes(b.status)
    && (!b.disputeDeadlineAt || new Date(b.disputeDeadlineAt) > new Date()) && !b.dispute;

  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Row justify="space-between"><H2>{b.title}</H2><BookingStatusPill status={b.status} audience="customer" /></Row>
      <Muted>{b.category.name} · Ref {b.reference}</Muted>
      <Spacer h={3} />

      {b.status === 'payment_pending' ? (
        <Banner tone="warning" title={`Pay within ${timeUntil(b.paymentDueAt)} to confirm`} body="Your pro is waiting. The booking is released if not paid in time." />
      ) : null}
      {b.status === 'completed_by_provider' ? (
        <Banner tone="warning" title="Is the job done to your satisfaction?"
          body={`Approve to release payment to your pro${b.autoApproveAt ? `, or report a problem. It will be approved automatically in ${timeUntil(b.autoApproveAt)}` : ''}.`} />
      ) : null}
      {b.status === 'disputed' && b.dispute ? <Banner tone="danger" title="We're reviewing a reported problem" body="Payment to the pro is on hold until our team resolves it." /> : null}
      {b.status === 'refunded' || b.status === 'refund_pending' ? <Banner tone="info" title={b.status === 'refunded' ? 'Refund issued' : 'Refund in progress'} body={b.cancelReason ?? undefined} /> : null}

      <Card>
        <Row gap={3}>
          <Avatar name={b.provider.name} />
          <View style={{ flex: 1 }}>
            <H3>{b.provider.name}</H3>
            <Row gap={1}>{b.provider.rating ? <><Stars value={Number(b.provider.rating)} size={13} /><Muted>{b.provider.rating}</Muted></> : <Muted>New pro</Muted>}</Row>
          </View>
          {b.provider.phone ? <Button small variant="secondary" icon="call" title="Call" onPress={() => Linking.openURL(`tel:${b.provider.phone}`)} /> : null}
        </Row>
        <Spacer h={2} />
        <Row gap={2}>
          <Button style={{ flex: 1 }} small variant="ghost" icon="chatbubble-ellipses-outline" title="Message" onPress={() => router.push({ pathname: '/request/[id]/chat', params: { id: b.requestId, providerId: b.provider.id, name: b.provider.name } })} />
          <Button style={{ flex: 1 }} small variant="ghost" icon="person-outline" title="Profile" onPress={() => router.push(`/provider/${b.provider.id}`)} />
        </Row>
      </Card>

      {tracking.data?.available ? (
        <Card>
          <Caption>Live location</Caption>
          <Spacer h={2} />
          <View style={styles.map}>
            <MapView style={StyleSheet.absoluteFill} region={{ latitude: tracking.data.lat!, longitude: tracking.data.lng!, latitudeDelta: 0.04, longitudeDelta: 0.04 }}>
              <Marker coordinate={{ latitude: tracking.data.lat!, longitude: tracking.data.lng! }} title={b.provider.name} pinColor={colors.brand} />
              <Marker coordinate={{ latitude: b.location.lat, longitude: b.location.lng }} title="You" />
            </MapView>
          </View>
          <Muted>{tracking.data.etaMin ? `About ${tracking.data.etaMin} min away` : ''} · updated {formatDateTime(tracking.data.at, { timeStyle: 'short' })}</Muted>
        </Card>
      ) : null}

      <Card>
        <KeyValue k="When" v={b.scheduledStartAt ? formatDateTime(b.scheduledStartAt) : 'As soon as possible'} />
        <KeyValue k="Where" v={b.location.addressText ?? b.location.areaLabel ?? '—'} />
        <Divider />
        <KeyValue k="Job price" v={formatMoney(b.pricing.agreed?.amount, b.pricing.agreed?.currency)} />
        <KeyValue k={`Service fee (${b.pricing.feePct ?? pc.customerFeePct}%)`} v={formatMoney(b.pricing.platformFee?.amount, b.pricing.platformFee?.currency)} />
        <KeyValue k="Total" v={formatMoney(b.pricing.total?.amount, b.pricing.total?.currency)} strong />
        {b.payment?.card_last4 ? <Muted>Paid with {b.payment.card_brand} •••• {b.payment.card_last4} · {formatDateTime(b.payment.captured_at)}</Muted> : null}
        {b.payment && Number(b.payment.amount_refunded) > 0 ? <Muted>Refunded {formatMoney(b.payment.amount_refunded, b.pricing.total?.currency)}</Muted> : null}
      </Card>

      {b.completionNotes || b.photos.length ? (
        <Card>
          <Caption>From your pro</Caption>
          {b.completionNotes ? <Body>{b.completionNotes}</Body> : null}
          <ScrollView horizontal style={{ marginTop: 8 }}>{b.photos.map(u => <Image key={u} source={{ uri: u }} style={{ width: 96, height: 96, borderRadius: radius.md, marginRight: 8 }} />)}</ScrollView>
        </Card>
      ) : null}

      {b.status === 'payment_pending' ? <Button title={`Pay ${formatMoney(b.pricing.total?.amount, b.pricing.total?.currency)}`} icon="lock-closed" onPress={() => router.push({ pathname: '/booking/[id]/pay', params: { id: b.id } })} /> : null}
      {can('approve') ? <Button title="Approve & release payment" icon="checkmark-circle" onPress={() => setConfirm('approve')} /> : null}
      {reviewable && completed ? <><Spacer h={2} /><Button title="Rate your pro" icon="star" variant="secondary" onPress={() => router.push({ pathname: '/booking/[id]/review', params: { id: b.id } })} /></> : null}
      {canDispute ? <><Spacer h={2} /><Button title="Report a problem" variant="danger" icon="alert-circle" onPress={() => router.push({ pathname: '/booking/[id]/problem', params: { id: b.id } })} /></> : null}
      {b.dispute ? <><Spacer h={2} /><Button title="View dispute" variant="secondary" onPress={() => router.push(`/dispute/${b.dispute!.id}`)} /></> : null}
      {b.status === 'assigned' ? <><Spacer h={2} /><Button title="Pro hasn't arrived" variant="ghost" onPress={() => setConfirm('noshow')} /></> : null}
      {can('cancel') ? <><Spacer h={2} /><Button title="Cancel booking" variant="ghost" onPress={() => setConfirm('cancel')} /></> : null}

      <Spacer h={6} />
      <H3>Timeline</H3>
      <Spacer h={3} />
      <Timeline events={b.timeline} />

      <ConfirmSheet visible={confirm === 'approve'} onClose={() => setConfirm(null)} loading={busy} title="Approve this job?"
        body={`Your pro will be paid ${pc.payoutDelayHours} hours from now. You can still report a problem within ${pc.disputeWindowHours} hours of completion.`}
        confirmLabel="Approve" onConfirm={() => run(() => api.bookings.approve(b.id)).then(() => router.push({ pathname: '/booking/[id]/review', params: { id: b.id } }))} />
      <Sheet visible={confirm === 'cancel' || confirm === 'noshow'} onClose={() => setConfirm(null)} title={confirm === 'noshow' ? 'Report a no-show' : 'Cancel booking'}>
        <Muted>{confirm === 'noshow'
          ? 'If your pro has not arrived, we refund you in full and immediately look for another pro.'
          : b.status === 'payment_pending' || b.status === 'payment_authorized'
            ? 'You will not be charged / you will be refunded in full.'
            : 'Free cancellation more than 2 hours before the start time. Later cancellations may keep a small fee to compensate the pro.'}</Muted>
        <Spacer h={3} />
        <Input label="Reason" value={reason} onChangeText={setReason} placeholder={confirm === 'noshow' ? 'e.g. 45 minutes late, not answering' : 'e.g. Plans changed'} />
        <Button title={confirm === 'noshow' ? 'Report no-show' : 'Cancel booking'} variant="danger" loading={busy}
          onPress={() => run(() => (confirm === 'noshow' ? api.bookings.reportNoShow(b.id, reason || 'Provider did not arrive') : api.bookings.cancel(b.id, reason || 'Customer cancelled')), confirm === 'noshow' ? 'We are refunding you and finding another pro.' : 'Booking cancelled')} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({ map: { height: 200, borderRadius: radius.lg, overflow: 'hidden', marginBottom: 8 } });
