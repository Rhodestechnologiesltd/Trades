import { useMemo, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { CATEGORY_ICONS, formatMoney, previewCustomerTotal } from '@trades/shared';
import {
  Banner, Body, Button, Card, Caption, H2, Input, Muted, PhotoStrip, Row, Screen, Segmented, Spacer, colors, errorMessage, normalizeAmount, radius, space, uploadUri, useApi,
} from '@trades/mobile-ui';
import { MapPicker, PickedLocation } from '../../src/components/MapPicker';
import { DateTimeField } from '../../src/components/DateTimeField';
import { findCategory, useAddresses, useCategories, usePublicConfig } from '../../src/hooks';

type Step = 'category' | 'details' | 'where' | 'review';

export default function NewRequest() {
  const params = useLocalSearchParams<{ categoryId?: string; mode?: 'urgent' | 'scheduled' }>();
  const api = useApi();
  const qc = useQueryClient();
  const cats = useCategories();
  const addresses = useAddresses();
  const pc = usePublicConfig();
  const [step, setStep] = useState<Step>(params.categoryId ? 'details' : 'category');
  const [categoryId, setCategoryId] = useState<string | undefined>(params.categoryId);
  const [subId, setSubId] = useState<string | undefined>();
  const [mode, setMode] = useState<'urgent' | 'scheduled'>(params.mode ?? 'scheduled');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [when, setWhen] = useState<Date | null>(null);
  const [budget, setBudget] = useState('');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [pin, setPin] = useState<PickedLocation | null>(null);
  const [shareExact, setShareExact] = useState(false);
  const [instant, setInstant] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = findCategory(cats.data, categoryId);
  const effective = findCategory(cats.data, subId) ?? category;
  const urgentAllowed = effective?.urgencyAllowed ?? true;
  const effMode = urgentAllowed ? mode : 'scheduled';
  const savedAddress = useMemo(() => addresses.data?.find(a => a.id === addressId), [addresses.data, addressId]);

  async function addPhoto() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6, allowsMultipleSelection: true, selectionLimit: 6 - photos.length });
    if (!r.canceled) setPhotos(p => [...p, ...r.assets.map(a => a.uri)].slice(0, 6));
  }

  function next() {
    setError(null);
    if (step === 'category') { if (!categoryId) return setError('Choose a service'); setStep('details'); }
    else if (step === 'details') {
      if (description.trim().length < 10) return setError('Describe the job in a few words (at least 10 characters)');
      if (effMode === 'scheduled' && !when) return setError('Choose when you need it');
      if (budget && !normalizeAmount(budget)) return setError('Budget must be a number');
      setStep('where');
    } else if (step === 'where') {
      if (!addressId && !pin) return setError('Choose an address or drop a pin');
      setStep('review');
    }
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      const photoKeys: string[] = [];
      for (const uri of photos) photoKeys.push(await uploadUri(api, 'request_photo', uri));
      const req = await api.requests.create({
        categoryId: (subId ?? categoryId)!, mode: effMode, description: description.trim(), photoKeys,
        scheduledFor: effMode === 'scheduled' ? when!.toISOString() : undefined,
        budgetHint: budget ? normalizeAmount(budget)! : undefined,
        addressId: addressId ?? undefined,
        location: addressId ? undefined : { lat: pin!.lat, lng: pin!.lng, source: pin!.source, addressText: pin!.addressText, areaLabel: pin!.areaLabel },
        precisionLevel: shareExact ? 'exact' : 'approximate',
        instantAccept: effMode === 'urgent' && !!effective?.instantAcceptPrice && instant,
        urgencyLevel: effMode === 'urgent' ? 'high' : undefined,
      });
      qc.invalidateQueries({ queryKey: ['requests'] });
      router.replace(`/request/${req.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const footer = step === 'review'
    ? <Button title={effMode === 'urgent' ? 'Send urgent request' : 'Get quotes'} variant={effMode === 'urgent' ? 'urgent' : 'primary'} onPress={submit} loading={busy} />
    : <Button title="Continue" onPress={next} />;

  return (
    <Screen footer={footer}>
      <Row gap={1} style={{ marginBottom: space(4) }}>
        {(['category', 'details', 'where', 'review'] as Step[]).map((s, i) => (
          <View key={s} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: ['category', 'details', 'where', 'review'].indexOf(step) >= i ? colors.brand : colors.border }} />
        ))}
      </Row>
      {error ? <Banner tone="danger" title={error} /> : null}

      {step === 'category' ? (
        <>
          <H2>Which service?</H2>
          <Spacer h={3} />
          {(cats.data ?? []).map(c => (
            <Card key={c.id} onPress={() => { setCategoryId(c.id); setSubId(undefined); setStep('details'); }} tone={categoryId === c.id ? 'brand' : undefined}>
              <Row gap={3}>
                <Ionicons name={(c.icon ?? CATEGORY_ICONS[c.slug] ?? 'construct') as any} size={22} color={colors.brand} />
                <Body style={{ flex: 1, fontWeight: '600' }}>{c.name}</Body>
                {c.requiresBackgroundCheck ? <Muted>Background-checked</Muted> : c.requiresLicense ? <Muted>Licensed</Muted> : null}
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {step === 'details' && category ? (
        <>
          <Pressable onPress={() => setStep('category')}><Caption>{category.name} · change</Caption></Pressable>
          <Spacer h={2} />
          <H2>Tell us about the job</H2>
          <Spacer h={3} />
          {category.children.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space(4) }}>
              {category.children.map(s => (
                <Pressable key={s.id} onPress={() => setSubId(subId === s.id ? undefined : s.id)}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1.5, borderColor: subId === s.id ? colors.brand : colors.border, backgroundColor: subId === s.id ? colors.brandSoft : colors.surface }}>
                  <Text style={{ color: subId === s.id ? colors.brandDark : colors.text, fontWeight: '500' }}>{s.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {urgentAllowed ? (
            <>
              <Segmented value={mode} onChange={setMode} options={[{ value: 'urgent', label: 'Urgent — now', icon: 'flash' }, { value: 'scheduled', label: 'Schedule', icon: 'calendar' }]} />
              <Spacer h={4} />
            </>
          ) : <Banner tone="info" title={`${category.name} is booked in advance`} body="Choose a date and time below. For regular visits, set up a regular service from Home." />}
          {effMode === 'scheduled' ? <DateTimeField label="When?" value={when} onChange={setWhen} minimumDate={new Date(Date.now() + 60 * 60_000)} /> : null}
          <Input label="What needs doing?" multiline value={description} onChangeText={setDescription} maxLength={4000}
            placeholder={effMode === 'urgent' ? 'e.g. Water leaking from the pipe under the kitchen sink, mains turned off' : 'e.g. Install 3 ceiling lights in the living room'} />
          <Caption>Photos help pros quote accurately</Caption>
          <Spacer h={2} />
          <PhotoStrip uris={photos} onAdd={addPhoto} onRemove={i => setPhotos(p => p.filter((_, j) => j !== i))} />
          <Spacer h={4} />
          <Input label="Budget (optional)" prefix={pc.currency} keyboardType="decimal-pad" value={budget} onChangeText={setBudget} hint="Guidance only — pros send their own quotes." />
        </>
      ) : null}

      {step === 'where' ? (
        <>
          <H2>Where?</H2>
          <Spacer h={3} />
          {(addresses.data ?? []).map(a => (
            <Card key={a.id} onPress={() => { setAddressId(a.id); setPin(null); }} tone={addressId === a.id ? 'brand' : undefined}>
              <Row gap={3}>
                <Ionicons name={addressId === a.id ? 'radio-button-on' : 'radio-button-off'} size={20} color={colors.brand} />
                <View style={{ flex: 1 }}><Body style={{ fontWeight: '600' }}>{a.label}</Body><Muted>{a.line1}, {a.city}</Muted></View>
              </Row>
            </Card>
          ))}
          <Card tone={!addressId && pin ? 'brand' : undefined}>
            <Body style={{ fontWeight: '600' }}>{addresses.data?.length ? 'Or pick a spot on the map' : 'Pick the spot on the map'}</Body>
            <Spacer h={2} />
            <MapPicker value={pin} onChange={l => { setPin(l); setAddressId(null); }} />
          </Card>
          <Row justify="space-between" style={{ paddingVertical: space(2) }}>
            <View style={{ flex: 1, paddingRight: space(3) }}>
              <Body style={{ fontWeight: '600' }}>Share exact location before booking</Body>
              <Muted>Off: pros see only your area until you accept and pay. Your exact address is always used for matching.</Muted>
            </View>
            <Switch value={shareExact} onValueChange={setShareExact} trackColor={{ true: colors.brand }} />
          </Row>
        </>
      ) : null}

      {step === 'review' && category ? (
        <>
          <H2>Review your request</H2>
          <Spacer h={3} />
          <Card>
            <Caption>{effective?.name}</Caption>
            <Spacer h={1} />
            <Body>{description}</Body>
            <Spacer h={2} />
            <Muted>{effMode === 'urgent' ? '⚡ Urgent — as soon as possible' : `📅 ${when?.toLocaleString('en-GB')}`}</Muted>
            <Muted>📍 {savedAddress ? `${savedAddress.label} — ${savedAddress.line1}` : pin?.addressText ?? 'Pinned location'}</Muted>
            {budget ? <Muted>💰 Budget {formatMoney(normalizeAmount(budget), pc.currency)}</Muted> : null}
            {photos.length ? <Muted>📷 {photos.length} photo(s)</Muted> : null}
          </Card>
          {effMode === 'urgent' && effective?.instantAcceptPrice ? (
            <Card>
              <Row justify="space-between">
                <View style={{ flex: 1, paddingRight: space(3) }}>
                  <Body style={{ fontWeight: '700' }}>Fastest: fixed-price call-out</Body>
                  <Muted>The first available pro can accept instantly at {formatMoney(effective.instantAcceptPrice, pc.currency)} + {formatMoney(previewCustomerTotal(effective.instantAcceptPrice, pc.customerFeePct).fee, pc.currency)} service fee. You can still receive other quotes.</Muted>
                </View>
                <Switch value={instant} onValueChange={setInstant} trackColor={{ true: colors.brand }} />
              </Row>
            </Card>
          ) : null}
          <Banner tone="info" icon="shield-checkmark" title="How payment works"
            body={`Accept a quote, then pay securely by card. A ${pc.customerFeePct}% service fee is added to the quoted price. Your money is held until you approve the finished work.`} />
        </>
      ) : null}
    </Screen>
  );
}
