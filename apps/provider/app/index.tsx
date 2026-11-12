import { Redirect } from 'expo-router';
import { Loading, useSession } from '@trades/mobile-ui';

export default function Index() {
  const { ready, me } = useSession();
  if (!ready) return <Loading />;
  if (!me) return <Redirect href="/(auth)/welcome" />;
  if (me.verification_status !== 'verified') return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)" />;
}
