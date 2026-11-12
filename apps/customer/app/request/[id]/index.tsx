import { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatDistance } from '@trades/shared';
import {
  Banner, Body, Button, Card, ConfirmSheet, EmptyState, H2, Loading, Muted, RequestStatusPill, Row, Screen, Spacer, colors, errorMessage, useApi,
} from '@trades/mobile-ui';
import { QuoteCard } from '../../../src/components/QuoteCard';
import { usePublicConfig } from '../../../src/hooks';

export default function RequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const pc = usePublicConfig();
  const q = useQuery({ queryKey: ['request', id], queryFn: () => api.requests.get(id), refetchInterval: d => (['dispatched', 'quoted', 'matching', 'requested'].includes(d.state.data?.status ?? '') ? 10_000 : false) });
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const r = q.data;

  useEffect(() => { if (r?.bookingId) router.replace(`/booking/${r.bookingId}`); }, [r?.bookingId]);
  if (q.isLoading || !r) return <Loading />;

  const refresh = () => qc.invalidateQueries({ queryKey: ['request', id] });
  const live = ['requested', 'matching', 'dispatched', 'quoted'].includes(r.status);
  const quotes = r.quotes ?? [];

  async function accept(quoteId: string) {
    setBusy(quoteId);
    try {
      const { bookingId } = await api.quotes.accept(quoteId);
      qc.invalidateQueries({ queryKey: ['requests'] });
      router.replace({ pathname: '/booking/[id]/pay', params: { id: bookingId } });
    } catch (e) { Alert.alert('Could not accept', errorMessage(e)); refresh(); } finally { setBusy(null); }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Row justify="space-between"><H2>{r.title}</H2><RequestStatusPill status={r.status} /></Row>
      <Muted>{r.category.name} · {r.mode === 'urgent' ? 'Urgent' : formatDateTime(r.scheduledFor)}</Muted>
      <Spacer h={3} />
      <Card>
        <Body>{r.description}</Body>
        {r.photos.length ? (
          <ScrollView horizontal style={{ marginTop: 10 }}>{r.photos.map(u => <Image key={u} source={{ uri: u }} style={{ width: 72, height: 72, borderRadius: 10, marginRight: 8 }} />)}</ScrollView>
        ) : null}
        <Spacer h={2} />
        <Muted>📍 {r.location.addressText ?? r.location.areaLabel ?? 'Pinned location'} {r.location.precision === 'approximate' ? '· exact address shared after booking' : ''}</Muted>
      </Card>

      {live && !quotes.length ? (
        <Banner tone="info" icon="radio" title="Finding available pros near you"
          body={`${r.dispatchStats?.notified ?? 0} pros notified within ${formatDistance(r.searchRadiusM)}${r.dispatchStats?.viewed ? ` · ${r.dispatchStats.viewed} viewing` : ''}. We'll notify you when quotes arrive — we widen the search automatically if needed.`} />
      ) : null}
      {r.status === 'expired' ? (
        <EmptyState icon="sad-outline" title="No pros available right now"
          body="Nobody was free in your area. Try again shortly, choose a later time, or contact support for help."
          action={<Button title="Try again" onPress={() => router.replace({ pathname: '/request/new', params: { categoryId: r.category.id } })} />} />
      ) : null}

      {quotes.length ? <><Spacer h={2} /><H2>{quotes.length} quote{quotes.length > 1 ? 's' : ''}</H2><Muted>Sorted by price. Tap a name to see reviews.</Muted><Spacer h={3} /></> : null}
      {quotes.map(qt => (
        <QuoteCard key={qt.id} q={qt} feePct={pc.customerFeePct} busy={busy === qt.id}
          onAccept={() => accept(qt.id)}
          onCounter={async (amount, message) => { await api.quotes.counter(qt.id, amount, message); refresh(); }}
          onRespond={async (co, action, amount) => {
            const res = await api.quotes.respond(co.id, action, amount);
            if (res.bookingId) router.replace({ pathname: '/booking/[id]/pay', params: { id: res.bookingId } }); else refresh();
          }}
          onChat={() => router.push({ pathname: '/request/[id]/chat', params: { id: r.id, providerId: qt.provider.id, name: qt.provider.name } })}
        />
      ))}

      {live ? <><Spacer h={4} /><Button title="Cancel request" variant="danger" onPress={() => setCancelOpen(true)} /></> : null}
      <ConfirmSheet visible={cancelOpen} onClose={() => setCancelOpen(false)} danger title="Cancel this request?"
        body="Pros will be told the job is no longer available. You haven't been charged anything." confirmLabel="Cancel request"
        onConfirm={async () => { try { await api.requests.cancel(r.id, 'Customer cancelled'); setCancelOpen(false); refresh(); } catch (e) { Alert.alert('Error', errorMessage(e)); } }} />
      <View style={{ height: 20 }} />
      <Muted center>Ref {r.id.slice(0, 8)} · created {formatDateTime(r.createdAt)}</Muted>
      <View style={{ height: 1, backgroundColor: colors.border }} />
    </Screen>
  );
}
