import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CATEGORY_ICONS, formatDateTime } from '@trades/shared';
import { BookingStatusPill, Card, H1, H2, Loading, Muted, Row, Screen, Spacer, colors, radius, shadow, space, useApi, useSession } from '@trades/mobile-ui';
import { useCategories } from '../../src/hooks';

export default function Home() {
  const { me } = useSession();
  const api = useApi();
  const cats = useCategories();
  const active = useQuery({ queryKey: ['bookings', 'active'], queryFn: () => api.bookings.history({ status: 'active' }) });
  const openReqs = useQuery({ queryKey: ['requests', 'open'], queryFn: () => api.requests.list() });
  const live = (openReqs.data?.items ?? []).filter(r => ['requested', 'matching', 'dispatched', 'quoted'].includes(r.status));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <Screen refreshing={active.isRefetching} onRefresh={() => { active.refetch(); openReqs.refetch(); }}>
        <Muted>Hello {me?.full_name.split(' ')[0]} 👋</Muted>
        <H1>What do you need done?</H1>
        <Spacer h={4} />
        <Pressable onPress={() => router.push({ pathname: '/request/new', params: { mode: 'urgent' } })} style={styles.urgent} accessibilityRole="button">
          <View style={styles.urgentIcon}><Ionicons name="flash" size={22} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 17 }}>Need help right now?</Text>
            <Text style={{ color: '#FFE5E5', fontSize: 13, marginTop: 2 }}>Urgent request — nearby pros respond in minutes</Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color="#fff" />
        </Pressable>

        {live.length || active.data?.items.length ? <><Spacer h={6} /><H2>In progress</H2><Spacer h={3} /></> : null}
        {live.map(r => (
          <Card key={r.id} onPress={() => router.push(`/request/${r.id}`)} tone={r.request_mode === 'urgent' ? 'urgent' : undefined}>
            <Row justify="space-between">
              <Text style={{ fontWeight: '700', fontSize: 15, flex: 1 }} numberOfLines={1}>{r.title}</Text>
              <Text style={{ color: r.live_quotes ? colors.success : colors.info, fontWeight: '600', fontSize: 13 }}>
                {r.live_quotes ? `${r.live_quotes} quote${r.live_quotes > 1 ? 's' : ''}` : 'Finding pros…'}
              </Text>
            </Row>
            <Muted>{r.category_name} · {r.scheduled_for ? formatDateTime(r.scheduled_for) : 'As soon as possible'}</Muted>
          </Card>
        ))}
        {(active.data?.items ?? []).map(b => (
          <Card key={b.id} onPress={() => router.push(`/booking/${b.id}`)}>
            <Row justify="space-between">
              <Text style={{ fontWeight: '700', fontSize: 15, flex: 1 }} numberOfLines={1}>{b.title}</Text>
              <BookingStatusPill status={b.status} audience="customer" />
            </Row>
            <Muted>{b.counterparty_name} · {b.reference}</Muted>
          </Card>
        ))}

        <Spacer h={6} />
        <H2>Services</H2>
        <Spacer h={3} />
        {cats.isLoading ? <Loading /> : (
          <View style={styles.grid}>
            {(cats.data ?? []).map(c => (
              <Pressable key={c.id} style={styles.tile} onPress={() => router.push({ pathname: '/request/new', params: { categoryId: c.id } })} accessibilityRole="button" accessibilityLabel={c.name}>
                <View style={styles.tileIcon}><Ionicons name={(c.icon ?? CATEGORY_ICONS[c.slug] ?? 'construct') as any} size={24} color={colors.brand} /></View>
                <Text style={styles.tileText} numberOfLines={2}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Spacer h={4} />
        <Card onPress={() => router.push('/recurring')}>
          <Row gap={3}>
            <Ionicons name="repeat" size={24} color={colors.brand} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', fontSize: 15 }}>Regular services</Text>
              <Muted>Weekly cleaning, after-school nanny, garden care — same trusted pro every time.</Muted>
            </View>
          </Row>
        </Card>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  urgent: { flexDirection: 'row', alignItems: 'center', gap: space(3), backgroundColor: colors.urgent, borderRadius: radius.lg, padding: space(4), ...shadow },
  urgentIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space(1.5) },
  tile: { width: '33.33%', padding: space(1.5) },
  tileIcon: { height: 64, borderRadius: radius.lg, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...shadow },
  tileText: { fontSize: 12.5, textAlign: 'center', marginTop: space(1.5), color: colors.text, fontWeight: '500' },
});
