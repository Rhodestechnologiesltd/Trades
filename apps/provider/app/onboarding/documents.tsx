import { useState } from 'react';
import { Alert, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Muted, Pill, Row, Screen, Spacer, colors, errorMessage, uploadUri, useApi } from '@trades/mobile-ui';
import { useProviderMe } from '../../src/hooks';

type Kind = 'id_front' | 'id_back' | 'selfie' | 'license' | 'background_check' | 'proof_of_address';
const STATUS_TONE: Record<string, any> = { uploaded: 'info', approved: 'success', rejected: 'danger', expired: 'warning' };

export default function Documents() {
  const me = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!me) return null;

  const latest = (kind: string, categoryId?: string) => me.documents.find(d => d.kind === kind && (!categoryId || d.category_id === categoryId));

  async function upload(kind: Kind, source: 'camera' | 'library' | 'file', categoryId?: string, purpose: 'kyc' | 'license' = 'kyc') {
    const key = `${kind}:${categoryId ?? ''}`;
    try {
      let uri: string | undefined; let mime: string | undefined;
      if (source === 'file') {
        const r = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'] });
        if (r.canceled) return; uri = r.assets[0].uri; mime = r.assets[0].mimeType;
      } else {
        if (source === 'camera') await ImagePicker.requestCameraPermissionsAsync();
        const r = source === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 0.7, cameraType: kind === 'selfie' ? 'front' : 'back' })
          : await ImagePicker.launchImageLibraryAsync({ quality: 0.7 });
        if (r.canceled) return; uri = r.assets[0].uri; mime = r.assets[0].mimeType;
      }
      setBusy(key);
      const storageKey = await uploadUri(api, purpose, uri!, mime);
      await api.providers.addDocument({ kind, storageKey, categoryId });
      qc.invalidateQueries({ queryKey: ['provider-me'] });
    } catch (e) { Alert.alert('Upload failed', errorMessage(e)); } finally { setBusy(null); }
  }

  const row = (kind: Kind, title: string, hint: string, opts: { categoryId?: string; selfie?: boolean; purpose?: 'kyc' | 'license' } = {}) => {
    const d = latest(kind, opts.categoryId);
    const key = `${kind}:${opts.categoryId ?? ''}`;
    return (
      <Card key={key}>
        <Row justify="space-between">
          <Body style={{ fontWeight: '700', flex: 1 }}>{title}</Body>
          {d ? <Pill label={d.status} tone={STATUS_TONE[d.status]} /> : <Ionicons name="ellipse-outline" size={20} color={colors.textFaint} />}
        </Row>
        <Muted>{d?.status === 'rejected' && d.notes ? `Rejected: ${d.notes}` : hint}</Muted>
        <Spacer h={2} />
        <Row gap={2}>
          <Button small style={{ flex: 1 }} variant="secondary" icon="camera" title={opts.selfie ? 'Take selfie' : 'Camera'} loading={busy === key} onPress={() => upload(kind, 'camera', opts.categoryId, opts.purpose)} />
          {!opts.selfie ? <Button small style={{ flex: 1 }} variant="ghost" icon="document" title="Upload file" onPress={() => upload(kind, 'file', opts.categoryId, opts.purpose)} /> : null}
        </Row>
      </Card>
    );
  };

  return (
    <Screen>
      <Muted>Documents are encrypted and only seen by our verification team. They are never shown to customers.</Muted>
      <Spacer h={3} />
      {row('id_front', 'National ID card — front', 'Clear photo, all four corners visible')}
      {row('id_back', 'National ID card — back', 'Optional but speeds up verification')}
      {row('selfie', 'Selfie', 'Face the camera in good light — we match it to your ID', { selfie: true })}
      {me.categories.filter(c => c.requires_license).map(c => row('license', `${c.name} licence`, 'Trade licence or certificate of competency, with expiry date', { categoryId: c.category_id, purpose: 'license' }))}
      {me.categories.some(c => ['childcare'].includes(c.slug)) ? row('background_check', 'Certificate of character', 'Police clearance issued within the last 6 months — required for childcare') : null}
      <View style={{ height: 20 }} />
    </Screen>
  );
}
