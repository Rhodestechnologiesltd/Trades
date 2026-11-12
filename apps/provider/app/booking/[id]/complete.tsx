import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, H2, Input, Muted, PhotoStrip, Screen, Spacer, errorMessage, uploadUri, useApi } from '@trades/mobile-ui';
import { currentPosition, startTracking } from '../../../src/location';
import { usePublicConfig } from '../../../src/hooks';

export default function Complete() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const pc = usePublicConfig();
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addPhoto() {
    await ImagePicker.requestCameraPermissionsAsync();
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (!r.canceled) setPhotos(p => [...p, r.assets[0].uri]);
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      const photoKeys: string[] = [];
      for (const u of photos) photoKeys.push(await uploadUri(api, 'job_photo', u));
      const pos = await currentPosition();
      await api.bookings.complete(id, { notes: notes.trim() || undefined, photoKeys, lat: pos?.lat, lng: pos?.lng });
      await startTracking('idle');
      qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Mark as complete" onPress={submit} loading={busy} />}>
      <H2>Finish up</H2>
      <Muted>{`The customer will be asked to approve. You'll be paid ${pc.payoutDelayHours}h after approval (auto-approved after ${pc.autoApproveHours}h if they don't respond).`}</Muted>
      <Spacer h={4} />
      {error ? <Banner tone="danger" title={error} /> : null}
      <Muted>After photos protect you if there's a disagreement later.</Muted>
      <Spacer h={2} />
      <PhotoStrip uris={photos} onAdd={addPhoto} onRemove={i => setPhotos(p => p.filter((_, j) => j !== i))} />
      <Spacer h={4} />
      <Input label="Notes for the customer" multiline value={notes} onChangeText={setNotes} placeholder="What you did, parts used, care advice…" />
    </Screen>
  );
}
