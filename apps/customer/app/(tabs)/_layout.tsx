import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { colors, useApi } from '@trades/mobile-ui';

export default function TabsLayout() {
  const api = useApi();
  const { data } = useQuery({ queryKey: ['notifications', 'badge'], queryFn: () => api.notifications.feed(), refetchInterval: 60_000 });
  const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: string; size: number }) => <Ionicons name={name} color={color} size={size} />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { color: colors.text }, headerShadowVisible: false, headerStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Home', headerShown: false, tabBarIcon: icon('home') }} />
      <Tabs.Screen name="activity" options={{ title: 'My jobs', tabBarIcon: icon('briefcase') }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarIcon: icon('notifications'), tabBarBadge: data?.unreadCount ? data.unreadCount : undefined }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('person-circle') }} />
    </Tabs>
  );
}
