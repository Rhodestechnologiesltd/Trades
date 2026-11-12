import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, formatMoney } from '@trades/shared';
import { BookingStatusPill, Card, EmptyState, Loading, Muted, Pill, Row, Screen, Segmented, Spacer, useApi } from '@trades/mobile-ui';

export default function Schedule() {
  const api = useApi();
  const [tab, setTab] = useState<'active' | 'quotes' | 'past'>('active');
  const bookings = useQuery({ queryKey: ['bookings', tab], queryFn: () => api.bookings.history({ status: tab === 'past' ? 'past' : 'active' }), enabled: tab !== 'quotes' });
  const quotes = useQuery({ queryKey: ['my-quotes'], queryFn: () => api.quotes.mine(), enabled: tab === 'quotes' });
  const loading = tab === 'quotes' ? quotes.isLoading : bookings.isLoading;
  return (
    <Screen refreshing={bookings.isRefetching || quotes.isRefetching} onRefresh={() => (tab === 'quotes' ? quotes.refetch() : bookings.refetch())}>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: 'Booked' }, { value: 'quotes', label: 'My quotes' }, { value: 'past', label: 'Done' }]} />
      <Spacer h={4} />
      {loading ? <Loading /> : null}
      {tab !== 'quotes' && !loading && !bookings.data?.items.length ? <EmptyState icon="calendar-outline" title={tab === 'active' ? 'No booked jobs' : 'No completed jobs yet'} /> : null}
      {tab !== 'quotes' && bookings.data?.items.map(b => (
        <Card key={b.id} onPress={() => router.push(`/booking/${b.id}`)}>
          <Row justify="space-between"><Text style={{ fontWeight: '700', flex: 1 }} numberOfLines={1}>{b.title}</Text><BookingStatusPill status={b.status} audience="provider" /></Row>
          <Muted>{b.counterparty_name} · {b.area_label ?? ''}</Muted>
          <Row justify="space-between"><Muted>{b.scheduled_start_at ? formatDateTime(b.scheduled_start_at) : 'ASAP'}</Muted><Text style={{ fontWeight: '700' }}>{formatMoney(b.agreed_amount, b.currency_code)}</Text></Row>
        </Card>
      ))}
      {tab === 'quotes' && !loading && !quotes.data?.length ? <EmptyState icon="pricetags-outline" title="No quotes sent yet" /> : null}
      {tab === 'quotes' && quotes.data?.map((q: any) => (
        <Card key={q.id} onPress={() => (q.booking_id ? router.push(`/booking/${q.booking_id}`) : router.push(`/request/${q.service_request_id}`))}>
          <Row justify="space-between"><Text style={{ fontWeight: '700', flex: 1 }} numberOfLines={1}>{q.title}</Text><Pill label={q.status} tone={q.status === 'accepted' ? 'success' : q.status === 'countered' ? 'warning' : 'neutral'} /></Row>
          <Muted>{q.category_name} · {q.area_label ?? ''}</Muted>
          <Row justify="space-between">
            <Muted>{q.latest_counter?.status === 'proposed' && q.latest_counter.proposed_by === 'customer' ? `Customer offered ${formatMoney(q.latest_counter.amount, q.currency_code)} — respond` : `Sent ${formatDateTime(q.created_at, { dateStyle: 'medium' })}`}</Muted>
            <Text style={{ fontWeight: '700' }}>{formatMoney(q.amount, q.currency_code)}</Text>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
