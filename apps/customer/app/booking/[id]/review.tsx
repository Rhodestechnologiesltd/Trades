import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Body, Button, H2, Input, Muted, Row, Screen, Spacer, Stars, errorMessage, useApi } from '@trades/mobile-ui';

const DIMENSIONS: Array<[string, string]> = [['quality', 'Quality of work'], ['punctuality', 'Punctuality'], ['professionalism', 'Professionalism'], ['value', 'Value for money']];

export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [breakdown, setBreakdown] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!rating) return setError('Choose a star rating');
    setBusy(true);
    try {
      await api.reviews.create({ bookingId: id, rating, comment: comment.trim() || undefined, breakdown });
      qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Submit review" onPress={submit} loading={busy} />}>
      <H2>How did it go?</H2>
      <Muted>Reviews are revealed once both of you have rated each other, so you can be honest.</Muted>
      <Spacer h={5} />
      {error ? <Banner tone="danger" title={error} /> : null}
      <View style={{ alignItems: 'center' }}><Stars value={rating} size={40} onChange={setRating} /></View>
      <Spacer h={6} />
      {DIMENSIONS.map(([k, label]) => (
        <Row key={k} justify="space-between" style={{ marginBottom: 14 }}>
          <Body>{label}</Body>
          <Stars value={breakdown[k] ?? 0} size={22} onChange={n => setBreakdown(b => ({ ...b, [k]: n }))} />
        </Row>
      ))}
      <Spacer h={2} />
      <Input label="Tell others about your experience (optional)" multiline value={comment} onChangeText={setComment} maxLength={2000} />
    </Screen>
  );
}
