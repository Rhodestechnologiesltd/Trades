import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Body, Button, Card, H2, Input, Muted, Row, Screen, Spacer, colors, errorMessage, useApi } from '@trades/mobile-ui';
import { DateTimeField } from '../../src/components/DateTimeField';
import { useProviderMe } from '../../src/hooks';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Availability() {
  const me = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const [win, setWin] = useState<Record<number, { on: boolean; start: string; end: string }>>({});
  const [offFrom, setOffFrom] = useState<Date | null>(null);
  const [offTo, setOffTo] = useState<Date | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [instant, setInstant] = useState(false);

  useEffect(() => {
    if (!me) return;
    const init: Record<number, { on: boolean; start: string; end: string }> = {};
    for (let d = 0; d < 7; d++) {
      const w = me.availabilityWindows.find(x => x.weekday === d);
      init[d] = w ? { on: true, start: w.start_time.slice(0, 5), end: w.end_time.slice(0, 5) } : { on: d >= 1 && d <= 5, start: '08:00', end: '17:00' };
    }
    setWin(init);
    setInstant(!!me.instant_accept_enabled);
  }, [me]);

  async function save() {
    try {
      const windows = Object.entries(win).filter(([, v]) => v.on).map(([d, v]) => ({ weekday: Number(d), start: v.start, end: v.end }));
      if (windows.some(w => !/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end) || w.start >= w.end)) throw new Error('Use HH:MM and make sure each end time is after the start time');
      await api.providers.setAvailabilityWindows(windows);
      await api.providers.updateProfile({ instantAcceptEnabled: instant });
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      setMsg({ tone: 'success', text: 'Saved' });
    } catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); }
  }

  return (
    <Screen footer={<Button title="Save" onPress={save} />}>
      {msg ? <Banner tone={msg.tone} title={msg.text} /> : null}
      <H2>Weekly hours</H2>
      <Muted>Used to suggest arrival times for scheduled jobs. Urgent jobs follow your online switch.</Muted>
      <Spacer h={3} />
      {Object.entries(win).map(([d, v]) => (
        <Card key={d}>
          <Row justify="space-between">
            <Pressable onPress={() => setWin(w => ({ ...w, [d]: { ...v, on: !v.on } }))}><Text style={{ fontWeight: '700', fontSize: 15, color: v.on ? colors.text : colors.textFaint }}>{DAYS[Number(d)]}</Text></Pressable>
            <Switch value={v.on} onValueChange={on => setWin(w => ({ ...w, [d]: { ...v, on } }))} trackColor={{ true: colors.brand }} />
          </Row>
          {v.on ? (
            <Row gap={3}>
              <View style={{ flex: 1 }}><Input label="From" value={v.start} onChangeText={t => setWin(w => ({ ...w, [d]: { ...v, start: t } }))} /></View>
              <View style={{ flex: 1 }}><Input label="To" value={v.end} onChangeText={t => setWin(w => ({ ...w, [d]: { ...v, end: t } }))} /></View>
            </Row>
          ) : null}
        </Card>
      ))}
      <Card>
        <Row justify="space-between">
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Body style={{ fontWeight: '700' }}>Instant-accept urgent call-outs</Body>
            <Muted>Take urgent jobs at the platform's fixed call-out price with one tap — the fastest way to win emergency work.</Muted>
          </View>
          <Switch value={instant} onValueChange={setInstant} trackColor={{ true: colors.brand }} />
        </Row>
      </Card>
      <Spacer h={4} />
      <H2>Time off</H2>
      <Muted>You won't be offered scheduled jobs during this period.</Muted>
      <Spacer h={3} />
      <DateTimeField label="From" value={offFrom} onChange={setOffFrom} minimumDate={new Date()} />
      <DateTimeField label="Until" value={offTo} onChange={setOffTo} minimumDate={offFrom ?? new Date()} />
      <Button title="Add time off" variant="secondary" disabled={!offFrom || !offTo} onPress={async () => {
        try { await api.providers.addTimeOff(offFrom!.toISOString(), offTo!.toISOString()); setMsg({ tone: 'success', text: 'Time off added' }); setOffFrom(null); setOffTo(null); }
        catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); }
      }} />
    </Screen>
  );
}
