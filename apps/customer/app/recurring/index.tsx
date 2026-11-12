import { Alert, Text } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Button, Card, EmptyState, Loading, Muted, Pill, Row, Screen, Spacer, errorMessage, useApi } from '@trades/mobile-ui';

export default function Recurring() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recurring'], queryFn: () => api.recurring.list() });
  if (q.isLoading) return <Loading />;
  const act = async (id: string, action: 'pause' | 'resume' | 'cancel') => {
    try { await api.recurring.setStatus(id, action); qc.invalidateQueries({ queryKey: ['recurring'] }); } catch (e) { Alert.alert('Error', errorMessage(e)); }
  };
  return (
    <Screen footer={<Button title="Set up a regular service" icon="repeat" onPress={() => router.push('/recurring/new')} />} refreshing={q.isRefetching} onRefresh={q.refetch}>
      {!q.data?.length ? <EmptyState icon="repeat" title="No regular services" body="Weekly cleaning, school-run nanny, monthly garden care — keep the same trusted pro every visit." /> : null}
      {q.data?.map(r => (
        <Card key={r.id}>
          <Row justify="space-between"><Text style={{ fontWeight: '700', fontSize: 16 }}>{r.category_name}</Text><Pill label={r.status} tone={r.status === 'active' ? 'success' : 'neutral'} /></Row>
          <Muted>{r.schedule}</Muted>
          <Muted>{r.provider_name ? `With ${r.provider_name}` : 'First visit will be matched with a pro'}{r.agreed_rate ? ` · ${formatMoney(r.agreed_rate, r.currency_code)} per visit` : ''}</Muted>
          {r.nextVisits.length ? <Muted>Next: {r.nextVisits.map(v => formatDateTime(v, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')}</Muted> : null}
          <Spacer h={2} />
          <Row gap={2}>
            {r.status === 'active' ? <Button small variant="secondary" title="Pause" onPress={() => act(r.id, 'pause')} /> : null}
            {r.status === 'paused' ? <Button small variant="secondary" title="Resume" onPress={() => act(r.id, 'resume')} /> : null}
            {r.status !== 'cancelled' ? <Button small variant="ghost" title="End" onPress={() => act(r.id, 'cancel')} /> : null}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
