import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, EmptyState, ListItem, Loading, Pill, Screen, Spacer, useApi } from '@trades/mobile-ui';
import { useAddresses } from '../../src/hooks';

export default function Addresses() {
  const q = useAddresses();
  const api = useApi();
  const qc = useQueryClient();
  if (q.isLoading) return <Loading />;
  return (
    <Screen footer={<Button title="Add address" icon="add" onPress={() => router.push('/addresses/edit')} />}>
      {!q.data?.length ? <EmptyState icon="location-outline" title="No saved addresses" body="Save home, work or family addresses to book faster." /> : null}
      {q.data?.map(a => (
        <Card key={a.id}>
          <ListItem icon={a.label.toLowerCase() === 'work' ? 'briefcase' : 'home'} title={a.label} subtitle={`${a.line1}${a.line2 ? ', ' + a.line2 : ''}, ${a.city}`}
            right={a.is_default ? <Pill label="Default" tone="success" /> : undefined} onPress={() => router.push({ pathname: '/addresses/edit', params: { id: a.id } })} />
          {!a.is_default ? <Button small variant="ghost" title="Make default" onPress={async () => { await api.addresses.update(a.id, { makeDefault: true }); qc.invalidateQueries({ queryKey: ['addresses'] }); }} /> : null}
        </Card>
      ))}
      <Spacer h={10} />
    </Screen>
  );
}
