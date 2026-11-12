import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Body, Button, Input, Muted, Row, Screen, Spacer, colors, errorMessage, useApi } from '@trades/mobile-ui';
import { MapPicker, PickedLocation } from '../../src/components/MapPicker';
import { useAddresses } from '../../src/hooks';

export default function EditAddress() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const existing = useAddresses().data?.find(a => a.id === id);
  const [label, setLabel] = useState('Home');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const [exact, setExact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing) return;
    setLabel(existing.label); setLine1(existing.line1); setLine2(existing.line2 ?? ''); setCity(existing.city); setNotes(existing.access_notes ?? '');
    setPin({ lat: existing.lat, lng: existing.lng, source: 'manual' }); setExact(existing.precision_level === 'exact');
  }, [existing]);

  async function save() {
    if (!pin) return setError('Set the location on the map');
    if (!line1.trim() || !city.trim()) return setError('Street and town are required');
    setBusy(true);
    try {
      const body = { label, line1: line1.trim(), line2: line2.trim() || undefined, city: city.trim(), accessNotes: notes.trim() || undefined, lat: pin.lat, lng: pin.lng, precisionLevel: exact ? 'exact' : 'approximate' };
      if (id) await api.addresses.update(id, body); else await api.addresses.create(body);
      qc.invalidateQueries({ queryKey: ['addresses'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Save address" onPress={save} loading={busy} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      <MapPicker value={pin} onChange={l => { setPin(l); if (!line1 && l.addressText) setLine1(l.addressText.split(',')[0] ?? ''); if (!city && l.city) setCity(l.city); }} height={220} />
      <Spacer h={4} />
      <Input label="Label" value={label} onChangeText={setLabel} placeholder="Home, Work, Mum's place" />
      <Input label="Street address" value={line1} onChangeText={setLine1} />
      <Input label="Apartment, building, landmark (optional)" value={line2} onChangeText={setLine2} />
      <Input label="Town / village" value={city} onChangeText={setCity} />
      <Input label="Access notes (shared only after booking)" value={notes} onChangeText={setNotes} placeholder="Gate code, parking, dog in the yard…" />
      <Row justify="space-between">
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Body style={{ fontWeight: '600' }}>Show exact location to quoting pros</Body>
          <Muted>Off by default — pros see the neighbourhood only until you book.</Muted>
        </View>
        <Switch value={exact} onValueChange={setExact} trackColor={{ true: colors.brand }} />
      </Row>
      {id ? <><Spacer h={4} /><Button title="Delete address" variant="danger" onPress={async () => { await api.addresses.remove(id); qc.invalidateQueries({ queryKey: ['addresses'] }); router.back(); }} /></> : null}
    </Screen>
  );
}
