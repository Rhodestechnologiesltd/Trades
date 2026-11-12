import { useState } from 'react';
import { Image, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DISPUTE_REASONS, formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Body, Button, Card, Caption, H2, Input, Loading, Muted, Pill, Row, Screen, Spacer, colors, errorMessage, useApi, useSession } from '@trades/mobile-ui';

const RESOLUTION: Record<string, string> = {
  refund_full: 'Full refund', refund_partial: 'Partial refund', release_to_provider: 'Payment released to the pro', split: 'Split settlement',
};

export default function DisputeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const { me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dispute', id], queryFn: () => api.disputes.get(id), refetchInterval: 30_000 });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = q.data;
  if (!d) return <Loading />;
  const open = ['opened', 'under_review', 'awaiting_evidence'].includes(d.status);

  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Row justify="space-between"><H2>{DISPUTE_REASONS[d.reason_code]}</H2><Pill label={d.status.replace('_', ' ')} tone={open ? 'warning' : 'success'} /></Row>
      <Muted>Booking {d.reference} · opened {formatDateTime(d.opened_at)}</Muted>
      <Spacer h={3} />
      {d.status === 'awaiting_evidence' ? <Banner tone="warning" title="Support needs more information" body={d.evidence_due_at ? `Please reply before ${formatDateTime(d.evidence_due_at)}.` : undefined} /> : null}
      {d.resolution ? (
        <Banner tone="success" title={`Resolved: ${RESOLUTION[d.resolution] ?? d.resolution}`}
          body={`${d.resolution_notes ?? ''}${d.resolution_amount && d.resolution !== 'refund_full' && d.resolution !== 'release_to_provider' ? `\nAdjusted job value: ${formatMoney(d.resolution_amount, d.currency_code)}` : ''}`} />
      ) : open ? <Banner tone="info" title="Our team is reviewing this" body={`Target response by ${formatDateTime(d.sla_due_at)}. Your payout is on hold meanwhile — add your side and any photos below.`} /> : null}
      <Card><Caption>Your report</Caption><Body>{d.description}</Body></Card>
      {d.messages.map(m => (
        <View key={m.id} style={{ alignSelf: m.author_user_id === me?.id ? 'flex-end' : 'flex-start', maxWidth: '85%', marginBottom: 10 }}>
          <View style={{ backgroundColor: m.author_user_id === me?.id ? colors.brandSoft : colors.surface, padding: 12, borderRadius: 14 }}>
            <Caption>{m.author_user_id === me?.id ? 'You' : m.author_role === 'customer' ? 'Customer' : 'Trades support'}</Caption>
            <Body>{m.body}</Body>
            {m.attachments.filter(Boolean).map(u => <Image key={u!} source={{ uri: u! }} style={{ width: 160, height: 120, borderRadius: 8, marginTop: 6 }} />)}
          </View>
          <Muted>{formatDateTime(m.created_at)}</Muted>
        </View>
      ))}
      {open ? (
        <>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Input label="Add a message" multiline value={msg} onChangeText={setMsg} />
          <Button title="Send" loading={busy} disabled={!msg.trim()} onPress={async () => {
            setBusy(true);
            try { await api.disputes.message(d.id, msg.trim()); setMsg(''); qc.invalidateQueries({ queryKey: ['dispute', id] }); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
          }} />
          <Spacer h={2} />
          <Button title="Withdraw — the problem is solved" variant="ghost" onPress={async () => { await api.disputes.withdraw(d.id); qc.invalidateQueries({ queryKey: ['dispute', id] }); }} />
        </>
      ) : null}
    </Screen>
  );
}
