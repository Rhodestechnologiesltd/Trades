import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, colors, registerForPush, useRealtime, useSession } from '@trades/mobile-ui';

function Bootstrap() {
  const { me, api } = useSession();
  useRealtime(!!me);
  useEffect(() => {
    if (!me) return;
    registerForPush(api).catch(() => undefined);
    // Deep link from a tapped push notification (payload.deepLink = trades://bookings/<id> etc.)
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const link: string | undefined = (r.notification.request.content.data as any)?.deepLink;
      const m = link?.match(/^trades:\/\/(requests|bookings|disputes)\/([\w-]+)/);
      if (m) router.push(`/${m[1] === 'bookings' ? 'booking' : m[1] === 'requests' ? 'request' : 'dispute'}/${m[2]}` as any);
    });
    return () => sub.remove();
  }, [me, api]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider app="customer">
        <Bootstrap />
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerTintColor: colors.brand, headerTitleStyle: { color: colors.text }, headerBackTitle: 'Back', contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="request/new" options={{ title: 'New request', presentation: 'modal' }} />
          <Stack.Screen name="request/[id]/index" options={{ title: 'Your request' }} />
          <Stack.Screen name="request/[id]/chat" options={{ title: 'Messages' }} />
          <Stack.Screen name="booking/[id]/index" options={{ title: 'Booking' }} />
          <Stack.Screen name="booking/[id]/pay" options={{ title: 'Secure payment', presentation: 'modal' }} />
          <Stack.Screen name="booking/[id]/review" options={{ title: 'Rate your pro', presentation: 'modal' }} />
          <Stack.Screen name="booking/[id]/problem" options={{ title: 'Report a problem', presentation: 'modal' }} />
          <Stack.Screen name="dispute/[id]" options={{ title: 'Dispute' }} />
          <Stack.Screen name="addresses/index" options={{ title: 'Saved addresses' }} />
          <Stack.Screen name="addresses/edit" options={{ title: 'Address', presentation: 'modal' }} />
          <Stack.Screen name="recurring/index" options={{ title: 'Regular services' }} />
          <Stack.Screen name="recurring/new" options={{ title: 'New regular service', presentation: 'modal' }} />
          <Stack.Screen name="provider/[id]" options={{ title: 'Provider' }} />
          <Stack.Screen name="settings/sessions" options={{ title: 'Devices & sessions' }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
