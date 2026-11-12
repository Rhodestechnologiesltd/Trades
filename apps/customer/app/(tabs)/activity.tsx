import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { formatDateTime, formatMoney } from '@trades/shared';
import { BookingStatusPill, Button, Card, EmptyState, Loading, Muted, RequestStatusPill, Row, Screen, Segmented, Spacer, useApi } from '@trades/mobile-ui';

export default function Activity() {
  const api = useApi();
  const [tab, setTab] = useState<'requests' | 'active' | 'past'>('active');
  const requests = useQuery({ queryKey: ['requests', 'all'], queryFn: () => api.requests.list(), enabled: tab === 'requests' });
  const bookings = useInfiniteQuery({
    queryKey: ['bookings', tab], enabled: tab !== 'requests', initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.bookings.history({ status: tab === 'past' ? 'past' : 'active', cursor: pageParam }),
    getNextPageParam: p => p.nextCursor ?? undefined,
  });
  const items = bookings.data?.pages.flatMap(p => p.items) ?? [];
  const loading = tab === 'requests' ? requests.isLoading : bookings.isLoading;

  return (
    <Screen refreshing={requests.isRefetching || bookings.isRefetching} onRefresh={() => (tab === 'requests' ? requests.refetch() : bookings.refetch())}>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: 'Booked' }, { value: 'requests', label: 'Requests' }, { value: 'past', label: 'History' }]} />
      <Spacer h={4} />
      {loading ? <Loading /> : null}
      {tab === 'requests' && !loading && !requests.data?.items.length ? (
        <EmptyState icon="search" title="No requests yet" body="Post a job and nearby pros will send you quotes." action={<Button title="New request" onPress={() => router.push('/request/new')} />} />
      ) : null}
      {tab === 'requests' && requests.data?.items.map(r => (
        <Card key={r.id} onPress={() => (r.booking_id ? router.push(`/booking/${r.booking_id}`) : router.push(`/request/${r.id}`))}>
          <Row justify="space-between">
            <Text style={{ fontWeight: '700', flex: 1 }} numberOfLines={1}>{r.title}</Text>
            <RequestStatusPill status={r.status} />
          </Row>
          <Muted>{r.category_name} · {r.request_mode === 'urgent' ? 'Urgent' : formatDateTime(r.scheduled_for)}</Muted>
          {r.best_quote ? <Muted>{r.live_quotes} quote(s) · from {formatMoney(r.best_quote, r.currency_code)}</Muted> : null}
        </Card>
      ))}
      {tab !== 'requests' && !loading && !items.length ? (
        <EmptyState icon="briefcase-outline" title={tab === 'active' ? 'Nothing booked right now' : 'No past jobs yet'} />
      ) : null}
      {tab !== 'requests' && items.map(b => (
        <Card key={b.id} onPress={() => router.push(`/booking/${b.id}`)}>
          <Row justify="space-between">
            <Text style={{ fontWeight: '700', flex: 1 }} numberOfLines={1}>{b.title}</Text>
            <BookingStatusPill status={b.status} audience="customer" />
          </Row>
          <Muted>{b.counterparty_name} · {formatMoney(b.agreed_amount, b.currency_code)}</Muted>
          <Row justify="space-between">
            <Muted>{b.reference} · {formatDateTime(b.scheduled_start_at ?? b.created_at, { dateStyle: 'medium' })}</Muted>
            {tab === 'past' && !b.reviewed && ['payout_pending', 'payout_released', 'approved_by_customer'].includes(b.status)
              ? <Text style={{ color: '#B7791F', fontWeight: '600', fontSize: 13 }}>Rate ★</Text> : null}
          </Row>
        </Card>
      ))}
      {bookings.hasNextPage ? <View><Button title="Load more" variant="ghost" onPress={() => bookings.fetchNextPage()} loading={bookings.isFetchingNextPage} /></View> : null}
    </Screen>
  );
}
