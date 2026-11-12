import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timeAgo } from '@trades/shared';
import { Button, EmptyState, Loading, Muted, Screen, colors, space, useApi } from '@trades/mobile-ui';

function route(link?: string) {
  const m = link?.match(/^trades-provider:\/\/(requests|bookings|quotes|earnings|disputes)\/?([\w-]*)/);
  if (!m) return null;
  if (m[1] === 'earnings') return '/(tabs)/earnings';
  return `/${m[1] === 'bookings' ? 'booking' : m[1] === 'disputes' ? 'dispute' : 'request'}/${m[2]}`;
}

export default function Inbox() {
  const api = useApi();
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ['notifications', 'feed'], queryFn: () => api.notifications.feed() });
  const readAll = useMutation({ mutationFn: () => api.notifications.readAll(), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  if (feed.isLoading) return <Loading />;
  const items = feed.data?.items ?? [];
  return (
    <Screen refreshing={feed.isRefetching} onRefresh={feed.refetch}>
      {feed.data?.unreadCount ? <Button title="Mark all as read" variant="ghost" small onPress={() => readAll.mutate()} /> : null}
      {!items.length ? <EmptyState icon="notifications-outline" title="You're all caught up" body="New jobs, offers and payout updates will appear here." /> : null}
      {items.map(n => (
        <Pressable key={n.id} onPress={() => { api.notifications.read(n.id).then(() => qc.invalidateQueries({ queryKey: ['notifications'] })); const r = route(n.payload?.deepLink); if (r) router.push(r as any); }}
          style={{ backgroundColor: n.read_at ? colors.surface : colors.brandSoft, padding: space(4), borderRadius: 12, marginBottom: space(2) }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: n.read_at ? '500' : '700', fontSize: 15, flex: 1 }}>{n.title}</Text>
            <Muted>{timeAgo(n.created_at)}</Muted>
          </View>
          <Text style={{ color: colors.textMuted, marginTop: 4, lineHeight: 19 }}>{n.body}</Text>
        </Pressable>
      ))}
    </Screen>
  );
}
