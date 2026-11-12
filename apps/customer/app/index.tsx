import { Redirect } from 'expo-router';
import { Loading, useSession } from '@trades/mobile-ui';

export default function Index() {
  const { ready, me } = useSession();
  if (!ready) return <Loading />;
  return <Redirect href={me ? '/(tabs)' : '/(auth)/welcome'} />;
}
