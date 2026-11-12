import { useEffect, useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { JobFeedItem, formatDateTime, formatDistance, formatMoney, timeAgo, timeUntil } from '@trades/shared';
import { Banner, Card, EmptyState, H1, H2, Muted, Pill, Row, Screen, Spacer, colors, errorMessage, space, useApi, useSession } from '@trades/mobile-ui';
import { startTracking, stopTracking } from '../../src/location';

function JobCard({ j }: { j: JobFeedItem }) {
  const urgent = j.request_mode === 'urgent';
  return (
    <Card tone={urgent ? 'urgent' : undefined} onPress={() => router.push(`/request/${j.id}`)}>
      <Row justify="space-between">
        <Text style={{ fontWeight: '700', fontSize: 16, flex: 1 }} numberOfLines={1}>{j.title}</Text>
        {urgent ? <Pill label="URGENT" tone="danger" icon="flash" /> : <Pill label={j.request_mode === 'recurring' ? 'Regular' : 'Scheduled'} tone="info" />}
      </Row>
      <Muted>{j.category_name} · {j.area_label ?? 'Nearby'} · {formatDistance(j.distance_m)} (~{j.eta_min} min)</Muted>
      <Row justify="space-between" style={{ marginTop: 6 }}>
        <Muted>{urgent ? `Posted ${timeAgo(j.created_at)}` : formatDateTime(j.scheduled_for)}</Muted>
        {j.my_quote_status ? <Pill label={`Your quote: ${j.my_quote_status}`} tone="success" />
          : j.response_deadline ? <Text style={{ color: colors.urgent, fontWeight: '600', fontSize: 12 }}>Respond within {timeUntil(j.response_deadline)}</Text>
          : j.budget_hint ? <Muted>Budget {formatMoney(j.budget_hint, j.currency_code)}</Muted> : null}
      </Row>
    </Card>
  );
}

export default function Jobs() {
  const { me, refreshMe } = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const [online, setOnline] = useState(me?.availability_status === 'online');
  const [toggling, setToggling] = useState(false);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.dispatch.jobs(), refetchInterval: online ? 20_000 : false });

  useEffect(() => { if (online) startTracking('idle').catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(v: boolean) {
    setToggling(true);
    try {
      await api.providers.setAvailability(v ? 'online' : 'offline');
      setOnline(v);
      if (v) {
        const bg = await startTracking('idle');
        if (!bg) Alert.alert('Allow location "Always"', 'To keep receiving nearby urgent jobs while the app is in the background, allow location access all the time in Settings.');
      } else await stopTracking();
      await refreshMe();
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) { Alert.alert('Could not change status', errorMessage(e)); } finally { setToggling(false); }
  }

  const dispatched = jobs.data?.dispatched ?? [];
  const open = jobs.data?.open ?? [];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <Screen refreshing={jobs.isRefetching} onRefresh={jobs.refetch}>
        <Row justify="space-between">
          <View><Muted>Hi {me?.full_name.split(' ')[0]}</Muted><H1>{online ? 'You\'re online' : 'You\'re offline'}</H1></View>
          <Switch value={online} disabled={toggling} onValueChange={toggle} trackColor={{ true: colors.success }} style={{ transform: [{ scale: 1.2 }] }} />
        </Row>
        <Spacer h={2} />
        {!online ? <Banner tone="warning" title="Go online to receive urgent jobs" body="Scheduled jobs in your area still reach you by notification." /> : null}
        <Spacer h={2} />
        <H2>Sent to you</H2>
        <Spacer h={2} />
        {!dispatched.length ? <EmptyState icon="radio-outline" title="No new requests" body={online ? 'We\'ll alert you the moment a job near you comes in.' : 'Go online to start receiving jobs.'} /> : dispatched.map(j => <JobCard key={j.id} j={j} />)}
        {open.length ? <><Spacer h={4} /><H2>Open jobs nearby</H2><Muted>Other requests in your services and area you can still quote on.</Muted><Spacer h={2} />{open.map(j => <JobCard key={j.id} j={j} />)}</> : null}
        <View style={{ height: space(6) }} />
      </Screen>
    </SafeAreaView>
  );
}
