import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { CATEGORY_ICONS } from '@trades/shared';
import { Banner, Button, Card, Input, Muted, Row, Screen, Spacer, colors, errorMessage, normalizeAmount, useApi } from '@trades/mobile-ui';
import { useCategories, useProviderMe } from '../../src/hooks';

export default function Services() {
  const cats = useCategories();
  const me = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const [sel, setSel] = useState<Record<string, { min: string; max: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (me) setSel(Object.fromEntries(me.categories.map(c => [c.category_id, { min: '', max: '' }])));
  }, [me]);

  async function save() {
    const ids = Object.keys(sel);
    if (!ids.length) return setError('Choose at least one service');
    setBusy(true);
    try {
      await api.providers.setCategories(ids.map(id => ({ categoryId: id, priceBandMin: normalizeAmount(sel[id].min) ?? undefined, priceBandMax: normalizeAmount(sel[id].max) ?? undefined })));
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Save services" onPress={save} loading={busy} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      <Muted>Choose up to 10. You'll only receive jobs in these services.</Muted>
      <Spacer h={3} />
      {(cats.data ?? []).map(c => {
        const on = !!sel[c.id];
        return (
          <Card key={c.id} tone={on ? 'brand' : undefined}>
            <Pressable onPress={() => setSel(s => { const n = { ...s }; if (on) delete n[c.id]; else n[c.id] = { min: '', max: '' }; return n; })}>
              <Row gap={3}>
                <Ionicons name={(c.icon ?? CATEGORY_ICONS[c.slug] ?? 'construct') as any} size={22} color={colors.brand} />
                <Text style={{ flex: 1, fontSize: 16, fontWeight: '600' }}>{c.name}</Text>
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? colors.brand : colors.textFaint} />
              </Row>
            </Pressable>
            {on ? (
              <View style={{ marginTop: 10 }}>
                {c.requiresLicense ? <Banner tone="warning" title="Licence required" body="Upload your licence in Identity & licences — you'll get these jobs once it's approved." /> : null}
                {c.requiresBackgroundCheck ? <Banner tone="warning" title="Background check required" body="Upload a certificate of character (police clearance) in Identity & licences." /> : null}
                <Row gap={3}>
                  <View style={{ flex: 1 }}><Input label="Typical min" keyboardType="decimal-pad" value={sel[c.id].min} onChangeText={t => setSel(s => ({ ...s, [c.id]: { ...s[c.id], min: t } }))} /></View>
                  <View style={{ flex: 1 }}><Input label="Typical max" keyboardType="decimal-pad" value={sel[c.id].max} onChangeText={t => setSel(s => ({ ...s, [c.id]: { ...s[c.id], max: t } }))} /></View>
                </Row>
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
