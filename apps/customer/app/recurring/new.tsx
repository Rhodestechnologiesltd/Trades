import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { weeklyRule } from '@trades/shared';
import { Banner, Button, Caption, H2, Input, Muted, Row, Screen, Segmented, Spacer, colors, errorMessage, normalizeAmount, radius, useApi } from '@trades/mobile-ui';
import { useAddresses, useCategories, usePublicConfig } from '../../src/hooks';

const DAYS = [['MO', 'Mon'], ['TU', 'Tue'], ['WE', 'Wed'], ['TH', 'Thu'], ['FR', 'Fri'], ['SA', 'Sat'], ['SU', 'Sun']] as const;

export default function NewRecurring() {
  const api = useApi();
  const qc = useQueryClient();
  const cats = useCategories();
  const addresses = useAddresses();
  const pc = usePublicConfig();
  const [categoryId, setCategoryId] = useState<string>();
  const [addressId, setAddressId] = useState<string>();
  const [days, setDays] = useState<Array<typeof DAYS[number][0]>>(['TU']);
  const [hour, setHour] = useState('9');
  const [every, setEvery] = useState<'1' | '2'>('1');
  const [duration, setDuration] = useState('180');
  const [desc, setDesc] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const h = Number(hour);
    if (!categoryId || !addressId) return setError('Choose a service and an address');
    if (!days.length || !(h >= 6 && h <= 21)) return setError('Pick at least one day and a start hour between 6 and 21');
    if (desc.trim().length < 5) return setError('Describe what you need each visit');
    if (rate && !normalizeAmount(rate)) return setError('Rate must be a number');
    setBusy(true);
    try {
      await api.recurring.create({
        categoryId, addressId, cadenceRule: weeklyRule(days, h, 0, Number(every)), startsOn: new Date().toISOString(), durationMin: Number(duration) || 120,
        description: desc.trim(), agreedRate: rate ? normalizeAmount(rate)! : undefined,
      });
      qc.invalidateQueries({ queryKey: ['recurring'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const chip = (on: boolean) => ({ paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1.5, borderColor: on ? colors.brand : colors.border, backgroundColor: on ? colors.brandSoft : colors.surface });
  return (
    <Screen footer={<Button title="Create regular service" onPress={save} loading={busy} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      <H2>Service</H2><Spacer h={2} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(cats.data ?? []).map(c => <Pressable key={c.id} style={chip(categoryId === c.id)} onPress={() => setCategoryId(c.id)}><Text>{c.name}</Text></Pressable>)}
      </View>
      <Spacer h={5} />
      <H2>Schedule</H2><Spacer h={2} />
      <Segmented value={every} onChange={setEvery} options={[{ value: '1', label: 'Every week' }, { value: '2', label: 'Every 2 weeks' }]} />
      <Spacer h={3} />
      <Row gap={1.5} style={{ flexWrap: 'wrap' }}>
        {DAYS.map(([k, l]) => <Pressable key={k} style={chip(days.includes(k))} onPress={() => setDays(d => (d.includes(k) ? d.filter(x => x !== k) : [...d, k]))}><Text>{l}</Text></Pressable>)}
      </Row>
      <Spacer h={3} />
      <Row gap={3}>
        <View style={{ flex: 1 }}><Input label="Start hour (24h)" keyboardType="number-pad" value={hour} onChangeText={setHour} /></View>
        <View style={{ flex: 1 }}><Input label="Duration (min)" keyboardType="number-pad" value={duration} onChangeText={setDuration} /></View>
      </Row>
      <H2>Where</H2><Spacer h={2} />
      {addresses.data?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {addresses.data.map(a => <Pressable key={a.id} style={chip(addressId === a.id)} onPress={() => setAddressId(a.id)}><Text>{a.label}</Text></Pressable>)}
        </View>
      ) : <Button title="Add an address first" variant="secondary" onPress={() => router.push('/addresses/edit')} />}
      <Spacer h={5} />
      <Input label="Each visit" multiline value={desc} onChangeText={setDesc} placeholder="e.g. Full house clean, 3 bedrooms, ironing included" />
      <Input label="Agreed rate per visit (optional)" prefix={pc.currency} keyboardType="decimal-pad" value={rate} onChangeText={setRate}
        hint="Set a rate and your regular pro can confirm each visit with one tap. Leave empty to receive quotes." />
      <Caption>How it works</Caption>
      <Muted>We create each visit ahead of time and offer it to the same pro first. You pay per visit, and can pause or end any time.</Muted>
    </Screen>
  );
}
