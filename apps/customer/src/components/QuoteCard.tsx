import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { CounterOffer, QuoteView, formatMoney, previewCustomerTotal, timeUntil } from '@trades/shared';
import { Avatar, Body, Button, Card, Input, Muted, Pill, Row, Sheet, Spacer, Stars, colors, errorMessage, normalizeAmount, space } from '@trades/mobile-ui';

export function QuoteCard({ q, feePct, busy, onAccept, onCounter, onRespond, onChat }: {
  q: QuoteView; feePct: number; busy?: boolean;
  onAccept: () => void; onCounter: (amount: string, message?: string) => Promise<void>;
  onRespond: (counter: CounterOffer, action: 'accept' | 'reject' | 'counter', amount?: string) => Promise<void>;
  onChat: () => void;
}) {
  const [sheet, setSheet] = useState<'counter' | 'recounter' | null>(null);
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rounds = q.counterOffers;
  const last = rounds[rounds.length - 1];
  const openProvider = last?.status === 'proposed' && last.proposed_by === 'provider' ? last : null;
  const waiting = last?.status === 'proposed' && last.proposed_by === 'customer';
  const current = openProvider?.amount ?? [...rounds].reverse().find(r => r.proposed_by === 'provider')?.amount ?? q.amount;
  const total = previewCustomerTotal(current, feePct);
  const negotiationOver = rounds.length > 0 && !rounds.some(r => r.status === 'proposed');

  async function submitCounter() {
    const a = normalizeAmount(amount);
    if (!a) return setErr('Enter a valid amount');
    setErr(null);
    try {
      if (sheet === 'counter') await onCounter(a, msg || undefined);
      else if (openProvider) await onRespond(openProvider, 'counter', a);
      setSheet(null); setAmount(''); setMsg('');
    } catch (e) { setErr(errorMessage(e)); }
  }

  return (
    <Card tone={q.isInstantAccept ? 'brand' : undefined}>
      <Row gap={3} align="flex-start">
        <Avatar name={q.provider.name} />
        <View style={{ flex: 1 }}>
          <Row justify="space-between">
            <Text style={{ fontWeight: '700', fontSize: 16, flex: 1 }} numberOfLines={1} onPress={() => router.push(`/provider/${q.provider.id}`)}>{q.provider.name}</Text>
            <Text style={{ fontWeight: '800', fontSize: 18, color: colors.text }}>{formatMoney(current, q.currency)}</Text>
          </Row>
          <Row gap={2}>
            {q.provider.rating ? <><Stars value={Number(q.provider.rating)} size={13} /><Muted>{q.provider.rating} ({q.provider.ratingCount})</Muted></> : <Muted>New on Trades</Muted>}
          </Row>
          <Muted>{q.provider.jobsCompleted} jobs done{q.etaMin ? ` · ~${q.etaMin} min away` : ''}{q.provider.verified ? ' · ✓ Verified' : ''}</Muted>
        </View>
      </Row>
      {q.message ? <><Spacer h={2} /><Body style={{ color: colors.textMuted }}>"{q.message}"</Body></> : null}
      {rounds.length ? (
        <View style={{ marginTop: space(3), padding: space(3), backgroundColor: colors.neutralSoft, borderRadius: 10 }}>
          {rounds.map(r => (
            <Row key={r.id} justify="space-between">
              <Muted>{r.proposed_by === 'customer' ? 'You offered' : 'Pro offered'} (round {r.round_number})</Muted>
              <Text style={{ fontWeight: '600', textDecorationLine: ['rejected', 'expired'].includes(r.status) ? 'line-through' : 'none' }}>{formatMoney(r.amount, r.currency_code)}</Text>
            </Row>
          ))}
        </View>
      ) : null}
      <Spacer h={2} />
      <Row justify="space-between">
        <Muted>Total incl. {feePct}% service fee: {formatMoney(total.total, q.currency)}</Muted>
        <Pill label={`valid ${timeUntil(q.validUntil)}`} tone="neutral" />
      </Row>
      <Spacer h={3} />
      {waiting ? <Pill label="Waiting for the pro to answer your offer" tone="info" /> : (
        <>
          <Button title={openProvider ? `Accept ${formatMoney(openProvider.amount, q.currency)}` : 'Accept quote'} onPress={onAccept} loading={busy} />
          <Spacer h={2} />
          <Row gap={2}>
            {openProvider ? (
              <>
                <Button style={{ flex: 1 }} small variant="secondary" title="Counter" onPress={() => setSheet('recounter')} />
                <Button style={{ flex: 1 }} small variant="danger" title="Decline offer" onPress={() => onRespond(openProvider, 'reject')} />
              </>
            ) : !negotiationOver && !q.isInstantAccept ? (
              <Button style={{ flex: 1 }} small variant="secondary" title="Make an offer" onPress={() => setSheet('counter')} />
            ) : null}
            <Button style={{ flex: 1 }} small variant="ghost" icon="chatbubble-ellipses-outline" title="Message" onPress={onChat} />
          </Row>
          {negotiationOver ? <Muted>Final offer — negotiation has ended.</Muted> : null}
        </>
      )}
      <Sheet visible={!!sheet} onClose={() => setSheet(null)} title="Make an offer">
        <Muted>The pro can accept, decline or come back with another price.</Muted>
        <Spacer h={3} />
        <Input label="Your price" prefix={q.currency} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} error={err} autoFocus />
        {sheet === 'counter' ? <Input label="Message (optional)" value={msg} onChangeText={setMsg} placeholder="e.g. Materials are already on site" /> : null}
        <Button title="Send offer" onPress={submitCounter} />
      </Sheet>
    </Card>
  );
}
