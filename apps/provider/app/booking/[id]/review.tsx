import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Body, Button, H2, Input, Muted, Row, Screen, Spacer, Stars, errorMessage, useApi } from '@trades/mobile-ui';

const DIMENSIONS: Array<[string, string]> = [['payment_promptness', 'Paid & approved promptly'], ['site_readiness', 'Site ready / easy access'], ['respectfulness', 'Respectful']];

export default function RateCustomer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [breakdown, setBreakdown] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen footer={<Button title="Submit" loading={busy} onPress={async () => {
      if (!rating) return setError('Choose a rating');
      setBusy(true);
      try { await api.reviews.create({ bookingId: id, rating, comment: comment.trim() || undefined, breakdown }); qc.invalidateQueries({ queryKey: ['booking', id] }); router.back(); }
      catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
    }} />}>
      <H2>How was this customer?</H2>
      <Muted>Only shown after both of you have reviewed. Helps other pros.</Muted>
      <Spacer h={5} />
      {error ? <Banner tone="danger" title={error} /> : null}
      <View style={{ alignItems: 'center' }}><Stars value={rating} onChange={setRating} size={40} /></View>
      <Spacer h={6} />
      {DIMENSIONS.map(([k, l]) => <Row key={k} justify="space-between" style={{ marginBottom: 14 }}><Body>{l}</Body><Stars value={breakdown[k] ?? 0} size={22} onChange={n => setBreakdown(b => ({ ...b, [k]: n }))} /></Row>)}
      <Input label="Comment (optional)" multiline value={comment} onChangeText={setComment} />
    </Screen>
  );
}
