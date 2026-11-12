import { useEffect } from 'react';
import { Vibration } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, colors, registerForPush, useRealtime, useSession } from '@trades/mobile-ui';
import '../src/location'; // registers the background location task at startup

function Bootstrap() {
  const { me, api } = useSession();
  useRealtime(!!me, event => { if (event === 'dispatch.provider_notified') Vibration.vibrate([0, 300, 150, 300]); });
  useEffect(() => {
    if (!me) return;
    registerForPush(api).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const link: string | undefined = (r.notification.request.content.data as any)?.deepLink;
      const m = link?.match(/^trades-provider:\/\/(requests|bookings|quotes|earnings)\/?([\w-]*)/);
      if (!m) return;
      if (m[1] === 'earnings') router.push('/(tabs)/earnings');
      else if (m[1] === 'bookings') router.push(`/booking/${m[2]}`);
      else router.push(`/request/${m[2]}`);
    });
    return () => sub.remove();
  }, [me, api]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider app="provider">
        <Bootstrap />
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerTintColor: colors.brand, headerTitleStyle: { color: colors.text }, headerBackTitle: 'Back', contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding/index" options={{ title: 'Get verified', headerBackVisible: false }} />
          <Stack.Screen name="onboarding/profile" options={{ title: 'Your profile' }} />
          <Stack.Screen name="onboarding/services" options={{ title: 'Services you offer' }} />
          <Stack.Screen name="onboarding/area" options={{ title: 'Where you work' }} />
          <Stack.Screen name="onboarding/documents" options={{ title: 'Identity & licences' }} />
          <Stack.Screen name="onboarding/payout" options={{ title: 'Payout account' }} />
          <Stack.Screen name="request/[id]/index" options={{ title: 'Job request' }} />
          <Stack.Screen name="request/[id]/chat" options={{ title: 'Messages' }} />
          <Stack.Screen name="booking/[id]/index" options={{ title: 'Job' }} />
          <Stack.Screen name="booking/[id]/complete" options={{ title: 'Complete job', presentation: 'modal' }} />
          <Stack.Screen name="booking/[id]/review" options={{ title: 'Rate customer', presentation: 'modal' }} />
          <Stack.Screen name="booking/[id]/problem" options={{ title: 'Report a problem', presentation: 'modal' }} />
          <Stack.Screen name="dispute/[id]" options={{ title: 'Dispute' }} />
          <Stack.Screen name="settings/availability" options={{ title: 'Working hours' }} />
          <Stack.Screen name="settings/sessions" options={{ title: 'Devices & sessions' }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
