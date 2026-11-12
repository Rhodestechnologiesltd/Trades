import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@trades/shared';
import { Avatar, Body, Card, Caption, EmptyState, H2, Loading, Muted, Pill, Row, Screen, Spacer, Stars, useApi } from '@trades/mobile-ui';

export default function ProviderProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const q = useQuery({ queryKey: ['provider', id], queryFn: () => api.providers.publicProfile(id) });
  const p = q.data;
  if (!p) return <Loading />;
  return (
    <Screen>
      <Row gap={3}>
        <Avatar name={p.business_name || p.full_name} size={64} />
        <View style={{ flex: 1 }}>
          <H2>{p.business_name || p.full_name}</H2>
          <Row gap={1}>{p.rating_avg ? <><Stars value={Number(p.rating_avg)} /><Muted>{p.rating_avg} · {p.rating_count} reviews</Muted></> : <Muted>No reviews yet</Muted>}</Row>
          <Spacer h={1} />
          <Row gap={2}>{p.verified ? <Pill label="ID verified" tone="success" icon="shield-checkmark" /> : null}<Pill label={`${p.jobs_completed} jobs`} /></Row>
        </View>
      </Row>
      <Spacer h={4} />
      {p.bio ? <Card><Body>{p.bio}</Body></Card> : null}
      <Card>
        <Caption>Services</Caption>
        {p.categories.map((c: any) => <Row key={c.id} justify="space-between"><Body>{c.name}</Body>{c.rating_avg ? <Muted>★ {c.rating_avg}</Muted> : null}</Row>)}
        <Spacer h={2} />
        <Muted>{p.years_experience ? `${p.years_experience} years experience · ` : ''}Speaks {(p.languages ?? []).join(', ') || '—'} · Member since {formatDateTime(p.member_since, { month: 'short', year: 'numeric' })}</Muted>
      </Card>
      <H2>Reviews</H2>
      <Spacer h={2} />
      {!p.reviews.length ? <EmptyState icon="star-outline" title="No reviews yet" /> : null}
      {p.reviews.map((r: any, i: number) => (
        <Card key={i}>
          <Row justify="space-between"><Stars value={r.rating} size={14} /><Muted>{formatDateTime(r.created_at, { dateStyle: 'medium' })}</Muted></Row>
          {r.comment ? <Body>{r.comment}</Body> : null}
          <Muted>— {r.reviewer_first_name}</Muted>
        </Card>
      ))}
    </Screen>
  );
}
