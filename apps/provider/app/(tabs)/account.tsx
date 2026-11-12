import { View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Card, H2, ListItem, Muted, Pill, Row, Screen, Spacer, Stars, useSession } from '@trades/mobile-ui';
import { useProviderMe } from '../../src/hooks';
import { stopTracking } from '../../src/location';

export default function Account() {
  const { signOut } = useSession();
  const p = useProviderMe().data;
  if (!p) return null;
  return (
    <Screen>
      <Card>
        <Row gap={3}>
          <Avatar name={p.business_name || p.full_name} size={56} />
          <View style={{ flex: 1 }}>
            <H2>{p.business_name || p.full_name}</H2>
            <Row gap={1}>{p.rating_avg ? <><Stars value={Number(p.rating_avg)} size={13} /><Muted>{p.rating_avg} · {p.rating_count} reviews</Muted></> : <Muted>No reviews yet</Muted>}</Row>
            <Spacer h={1} />
            <Pill label={p.verification_status === 'verified' ? 'Verified pro' : p.verification_status} tone={p.verification_status === 'verified' ? 'success' : 'warning'} />
          </View>
        </Row>
      </Card>
      <Card>
        <ListItem icon="person" title="Profile" onPress={() => router.push('/onboarding/profile')} />
        <ListItem icon="construct" title="Services & prices" subtitle={p.categories.map(c => c.name).join(', ')} onPress={() => router.push('/onboarding/services')} />
        <ListItem icon="map" title="Work area" onPress={() => router.push('/onboarding/area')} />
        <ListItem icon="time" title="Working hours & time off" onPress={() => router.push('/settings/availability')} />
        <ListItem icon="id-card" title="Documents & licences" onPress={() => router.push('/onboarding/documents')} />
        <ListItem icon="wallet" title="Payout account" onPress={() => router.push('/onboarding/payout')} />
      </Card>
      <Card>
        <ListItem icon="phone-portrait" title="Devices & sessions" onPress={() => router.push('/settings/sessions')} />
        <ListItem icon="help-buoy" title="Pro support" subtitle="pros@trades.mu · +230 400 0001" />
        <ListItem icon="log-out" title="Sign out" onPress={async () => { await stopTracking(); await signOut(); router.replace('/(auth)/welcome'); }} />
      </Card>
    </Screen>
  );
}
