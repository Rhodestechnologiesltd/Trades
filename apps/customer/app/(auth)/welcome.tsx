import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, H1, IconCircle, Muted, Row, Spacer, colors, space } from '@trades/mobile-ui';

const POINTS: Array<{ icon: any; title: string; body: string }> = [
  { icon: 'flash', title: 'Urgent help, fast', body: 'Burst pipe or no power? Nearby verified pros respond in minutes.' },
  { icon: 'pricetags', title: 'Compare quotes', body: 'See prices, ratings and arrival times — or make a counter-offer.' },
  { icon: 'shield-checkmark', title: 'Pay safely', body: 'Your payment is held until you approve the finished job.' },
];

export default function Welcome() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, padding: space(6), justifyContent: 'space-between' }}>
        <View>
          <Spacer h={10} />
          <IconCircle name="construct" size={64} />
          <Spacer h={5} />
          <H1>Trusted local pros, on demand</H1>
          <Spacer h={2} />
          <Muted>Electricians, plumbers, cleaners, nannies, mechanics and more — across Mauritius.</Muted>
          <Spacer h={8} />
          {POINTS.map(p => (
            <Row key={p.title} align="flex-start" gap={3} style={{ marginBottom: space(5) }}>
              <IconCircle name={p.icon} size={40} />
              <View style={{ flex: 1 }}>
                <Body style={{ fontWeight: '700' }}>{p.title}</Body>
                <Muted>{p.body}</Muted>
              </View>
            </Row>
          ))}
        </View>
        <View>
          <Button title="Get started" onPress={() => router.push({ pathname: '/(auth)/phone', params: { mode: 'register' } })} />
          <Spacer h={2} />
          <Button title="I already have an account" variant="ghost" onPress={() => router.push({ pathname: '/(auth)/phone', params: { mode: 'login' } })} />
        </View>
      </View>
    </SafeAreaView>
  );
}
