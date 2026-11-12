import { useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { DISPUTE_REASONS, DisputeReason } from '@trades/shared';
import { Banner, Button, Card, H2, Input, Muted, PhotoStrip, Row, Screen, Spacer, colors, errorMessage, uploadUri, useApi } from '@trades/mobile-ui';

export default function Problem() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [desc, setDesc] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addPhoto() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    if (!r.canceled) setPhotos(p => [...p, r.assets[0].uri]);
  }

  async function submit() {
    if (!reason) return setError('Choose what went wrong');
    if (desc.trim().length < 10) return setError('Please describe the problem (at least 10 characters)');
    setBusy(true); setError(null);
    try {
      const evidenceKeys: string[] = [];
      for (const u of photos) evidenceKeys.push(await uploadUri(api, 'dispute_evidence', u));
      const d = await api.disputes.open({ bookingId: id, reasonCode: reason, description: desc.trim(), evidenceKeys });
      qc.invalidateQueries({ queryKey: ['booking', id] });
      router.replace(`/dispute/${d.id}`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Submit to support" variant="danger" onPress={submit} loading={busy} />}>
      <H2>What went wrong?</H2>
      <Muted>Tell us what happened. Our team reviews both sides before deciding.</Muted>
      <Spacer h={4} />
      {error ? <Banner tone="danger" title={error} /> : null}
      {(Object.keys(DISPUTE_REASONS) as DisputeReason[]).filter(r => r !== 'no_show' && r !== 'incomplete_work').map(r => (
        <Card key={r} onPress={() => setReason(r)} tone={reason === r ? 'brand' : undefined}>
          <Row gap={3}>
            <Ionicons name={reason === r ? 'radio-button-on' : 'radio-button-off'} size={20} color={colors.brand} />
            <Text style={{ fontSize: 15, flex: 1 }}>{DISPUTE_REASONS[r]}</Text>
          </Row>
        </Card>
      ))}
      <Spacer h={2} />
      <Input label="Details" multiline value={desc} onChangeText={setDesc} placeholder="What happened? What would make it right?" />
      <Muted>Photos help us resolve it faster</Muted>
      <Spacer h={2} />
      <PhotoStrip uris={photos} onAdd={addPhoto} onRemove={i => setPhotos(p => p.filter((_, j) => j !== i))} />
      {reason === 'unsafe_conduct' ? <><Spacer h={4} /><Banner tone="danger" title="If you are in danger, call 999 (police) or 114 (SAMU) now." /></> : null}
    </Screen>
  );
}
