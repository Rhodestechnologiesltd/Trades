import { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Card, H1, ListItem, Loading, Muted, Screen, Spacer, colors, errorMessage, useApi, useSession } from '@trades/mobile-ui';
import { useProviderMe } from '../../src/hooks';

export default function Onboarding() {
  const q = useProviderMe();
  const api = useApi();
  const { refreshMe, signOut } = useSession();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const p = q.data;
  if (!p) return <Loading />;
  const o = p.onboarding;
  const steps: Array<{ key: keyof typeof o; title: string; subtitle: string; href: string; icon: any }> = [
    { key: 'profile', title: 'Profile', subtitle: 'Bio, experience, languages', href: '/onboarding/profile', icon: 'person' },
    { key: 'categories', title: 'Services', subtitle: 'Trades you offer and typical prices', href: '/onboarding/services', icon: 'construct' },
    { key: 'location', title: 'Work area', subtitle: 'Home base and how far you travel', href: '/onboarding/area', icon: 'map' },
    { key: 'identity', title: 'Identity check', subtitle: 'ID card + selfie', href: '/onboarding/documents', icon: 'id-card' },
    { key: 'licences', title: 'Licences', subtitle: 'Required for electrical & AC work', href: '/onboarding/documents', icon: 'ribbon' },
    { key: 'payoutAccount', title: 'Payout account', subtitle: 'Where we send your earnings', href: '/onboarding/payout', icon: 'wallet' },
  ];

  async function submit() {
    setBusy(true);
    try {
      await api.providers.submitVerification();
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      await refreshMe();
    } catch (e) { Alert.alert('Not quite ready', errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen refreshing={q.isRefetching} onRefresh={async () => { await q.refetch(); const m = await refreshMe(); if (m?.verification_status === 'verified') router.replace('/(tabs)'); }}
      footer={p.verification_status === 'pending' ? undefined : <Button title="Submit for verification" onPress={submit} loading={busy} disabled={!o.complete} />}>
      <H1>Let's get you verified</H1>
      <Spacer h={2} />
      <Muted>Every pro on Trades is identity-checked. It usually takes 1–2 working days.</Muted>
      <Spacer h={4} />
      {p.verification_status === 'pending' ? <Banner tone="info" icon="hourglass" title="Under review" body="We're checking your documents. We'll notify you as soon as you're approved — pull down to refresh." /> : null}
      {p.verification_status === 'rejected' ? <Banner tone="danger" title="We couldn't verify you yet" body={p.rejection_reason ?? 'Please update your documents and resubmit.'} /> : null}
      <Card>
        {steps.map(s => (
          <ListItem key={s.key} icon={s.icon} title={s.title} subtitle={s.subtitle} onPress={() => router.push(s.href as any)}
            right={<Ionicons name={o[s.key] ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={o[s.key] ? colors.success : colors.textFaint} />} />
        ))}
      </Card>
      <Button title="Sign out" variant="ghost" onPress={() => signOut().then(() => router.replace('/(auth)/welcome'))} />
    </Screen>
  );
}
