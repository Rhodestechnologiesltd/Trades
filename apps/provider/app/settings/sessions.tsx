import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@trades/shared';
import { Button, Card, ListItem, Loading, Muted, Pill, Screen, Spacer, useApi } from '@trades/mobile-ui';

export default function Sessions() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.auth.sessions() });
  if (q.isLoading) return <Loading />;
  return (
    <Screen>
      <Muted>Devices currently signed in to your account. Sign out any you don't recognise.</Muted>
      <Spacer h={3} />
      {q.data?.map(s => (
        <Card key={s.id}>
          <ListItem icon="phone-portrait" title={s.device_name ?? s.platform ?? 'Unknown device'} subtitle={`Signed in ${formatDateTime(s.created_at)}`}
            right={s.current ? <Pill label="This device" tone="success" /> : undefined} />
          {!s.current ? <Button small variant="danger" title="Sign out device" onPress={async () => { await api.auth.revokeSession(s.id); qc.invalidateQueries({ queryKey: ['sessions'] }); }} /> : null}
        </Card>
      ))}
    </Screen>
  );
}
