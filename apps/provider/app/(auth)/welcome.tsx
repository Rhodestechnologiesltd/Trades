import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, H1, IconCircle, Muted, Row, Spacer, colors, space } from '@trades/mobile-ui';
import { usePublicConfig } from '../../src/hooks';

export default function Welcome() {
  const pc = usePublicConfig();
  const points: Array<{ icon: any; title: string; body: string }> = [
    { icon: 'notifications', title: 'Jobs come to you', body: 'Get nearby requests in your trades and areas — urgent call-outs and scheduled work.' },
    { icon: 'pricetag', title: 'You set the price', body: 'Send quotes, negotiate, or accept fixed-price urgent call-outs instantly.' },
    { icon: 'wallet', title: 'Guaranteed payment', body: `Customers pay upfront. You're paid ${pc.payoutDelayHours}h after they approve, minus a ${pc.providerCommissionPct}% commission.` },
  ];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: space(6), justifyContent: 'space-between' }}>
        <View>
          <Spacer h={10} />
          <IconCircle name="hammer" size={64} />
          <Spacer h={5} />
          <H1>Grow your business with Trades Pro</H1>
          <Spacer h={2} />
          <Muted>For electricians, plumbers, cleaners, nannies, mechanics, painters, gardeners and more.</Muted>
          <Spacer h={8} />
          {points.map(p => (
            <Row key={p.title} align="flex-start" gap={3} style={{ marginBottom: space(5) }}>
              <IconCircle name={p.icon} size={40} />
              <View style={{ flex: 1 }}><Body style={{ fontWeight: '700' }}>{p.title}</Body><Muted>{p.body}</Muted></View>
            </Row>
          ))}
        </View>
        <View>
          <Button title="Join as a pro" onPress={() => router.push({ pathname: '/(auth)/phone', params: { mode: 'register' } })} />
          <Spacer h={2} />
          <Button title="I already have an account" variant="ghost" onPress={() => router.push({ pathname: '/(auth)/phone', params: { mode: 'login' } })} />
        </View>
      </View>
    </SafeAreaView>
  );
}
