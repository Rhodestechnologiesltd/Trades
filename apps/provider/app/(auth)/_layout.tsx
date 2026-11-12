import { Stack } from 'expo-router';
import { colors } from '@trades/mobile-ui';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerTintColor: colors.brand, headerTitle: '', headerShadowVisible: false, contentStyle: { backgroundColor: colors.bg } }}>
    <Stack.Screen name="welcome" options={{ headerShown: false }} />
  </Stack>;
}
