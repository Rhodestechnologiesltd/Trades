import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { colors, useApi } from '@trades/mobile-ui';

export default function TabsLayout() {
  const api = useApi();
  const n = useQuery({ queryKey: ['notifications', 'badge'], queryFn: () => api.notifications.feed(), refetchInterval: 60_000 });
  const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: string; size: number }) => <Ionicons name={name} color={color} size={size} />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerShadowVisible: false, headerStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Jobs', headerShown: false, tabBarIcon: icon('flash') }} />
      <Tabs.Screen name="schedule" options={{ title: 'My work', tabBarIcon: icon('calendar') }} />
      <Tabs.Screen name="earnings" options={{ title: 'Earnings', tabBarIcon: icon('wallet') }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarIcon: icon('notifications'), tabBarBadge: n.data?.unreadCount || undefined }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('person-circle') }} />
    </Tabs>
  );
}
