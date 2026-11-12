import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, formatMoney } from '@trades/shared';
import { Banner, Button, Card, Caption, EmptyState, H1, KeyValue, Loading, Muted, Pill, Row, Screen, Spacer, colors, useApi } from '@trades/mobile-ui';
import { usePublicConfig, useProviderMe } from '../../src/hooks';

const TONE: Record<string, any> = { payout_pending: 'info', processing: 'info', released: 'success', settled: 'success', held: 'warning', cancelled: 'neutral', clawed_back: 'danger' };
const LABEL: Record<string, string> = { payout_pending: 'Scheduled', processing: 'Sending', released: 'Paid', settled: 'Paid', held: 'On hold', cancelled: 'Cancelled', clawed_back: 'Reversed' };

export default function Earnings() {
  const api = useApi();
  const pc = usePublicConfig();
  const me = useProviderMe().data;
  const q = useQuery({ queryKey: ['earnings'], queryFn: () => api.providers.earnings() });
  if (q.isLoading) return <Loading />;
  const s = q.data?.summary;
  const cur = s?.currency_code ?? pc.currency;
  return (
    <Screen refreshing={q.isRefetching} onRefresh={q.refetch}>
      <Card>
        <Caption>Paid out</Caption>
        <H1>{formatMoney(s?.paid_out ?? 0, cur)}</H1>
        <Spacer h={2} />
        <KeyValue k="Scheduled" v={formatMoney(s?.pending ?? 0, cur)} />
        <KeyValue k="On hold" v={formatMoney(s?.held ?? 0, cur)} />
        <KeyValue k={`Commission paid (${pc.providerCommissionPct}%)`} v={formatMoney(s?.commission_paid ?? 0, cur)} />
        <KeyValue k="Jobs" v={String(s?.jobs ?? 0)} />
      </Card>
      {Number(q.data?.clawbackOutstanding ?? 0) > 0 ? (
        <Banner tone="warning" title={`${formatMoney(q.data!.clawbackOutstanding, cur)} owed from a refunded job`} body="Up to half of each upcoming payout is withheld until it's settled. Contact support to appeal." />
      ) : null}
      <Card>
        <Row justify="space-between">
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '700' }}>Payout account</Text>
            <Muted>{me?.payoutAccount ? `${me.payoutAccount.bank_name ?? me.payoutAccount.method} •••• ${me.payoutAccount.account_last4}` : 'Not set — add one to get paid'}</Muted>
          </View>
          <Button small variant="secondary" title={me?.payoutAccount ? 'Change' : 'Add'} onPress={() => router.push('/onboarding/payout')} />
        </Row>
      </Card>
      <Muted>Payouts are sent {pc.payoutDelayHours} hours after the customer approves the job, unless a problem is reported.</Muted>
      <Spacer h={3} />
      {!q.data?.payouts.length ? <EmptyState icon="wallet-outline" title="No payouts yet" body="Complete your first job to start earning." /> : null}
      {q.data?.payouts.map(p => (
        <Card key={p.id} onPress={() => router.push(`/booking/${p.booking_id}`)}>
          <Row justify="space-between"><Text style={{ fontWeight: '700' }}>{p.reference}</Text><Pill label={LABEL[p.status] ?? p.status} tone={TONE[p.status]} /></Row>
          <KeyValue k="Job price" v={formatMoney(p.gross_amount, p.currency_code)} />
          <KeyValue k="Commission" v={`− ${formatMoney(p.commission_deducted, p.currency_code)}`} />
          {Number(p.clawback_recovered) > 0 ? <KeyValue k="Refund recovery" v={`− ${formatMoney(p.clawback_recovered, p.currency_code)}`} /> : null}
          <KeyValue k="You receive" v={formatMoney((Number(p.net_payout_amount) - Number(p.clawback_recovered)).toFixed(2), p.currency_code)} strong />
          <Muted>{p.released_at ? `Paid ${formatDateTime(p.released_at)}` : p.hold_reason ? `On hold: ${p.hold_reason}` : `Expected ${formatDateTime(p.eligible_at)}`}</Muted>
        </Card>
      ))}
      <View style={{ height: 10, backgroundColor: colors.bg }} />
    </Screen>
  );
}
