'use client';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Category } from '@trades/shared';
import { formatMoney } from '@trades/shared';
import { RequireAuth, msg, useAsync, useSession } from '../../../src/client';

function NewRequestForm() {
  const { api, me } = useSession();
  const params = useMemo(() => new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''), []);
  const cats = useAsync(() => api.catalog.categories(), []);
  const addresses = useAsync(() => api.addresses.list(), []);
  const cfg = useAsync(() => api.catalog.publicConfig(me?.market?.id), [me?.market?.id]);
  const [categoryId, setCategoryId] = useState(params.get('categoryId') ?? '');
  const [mode, setMode] = useState<'urgent' | 'scheduled'>(params.get('mode') === 'urgent' ? 'urgent' : 'scheduled');
  const [description, setDescription] = useState('');
  const [when, setWhen] = useState('');
  const [addressId, setAddressId] = useState('');
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [addressText, setAddressText] = useState('');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flat: Category[] = (cats.data ?? []).flatMap(c => [c, ...c.children]);
  const cat = flat.find(c => c.id === categoryId);
  const urgentOk = cat?.urgencyAllowed ?? true;
  useEffect(() => { if (addresses.data?.length && !addressId) setAddressId(addresses.data.find(a => a.is_default)?.id ?? addresses.data[0].id); }, [addresses.data, addressId]);

  function locate() {
    navigator.geolocation.getCurrentPosition(p => { setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }); setAddressId(''); }, () => setError('Location permission denied — choose a saved address instead.'), { enableHighAccuracy: true, timeout: 10000 });
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!categoryId) return setError('Choose a service');
    if (description.trim().length < 10) return setError('Describe the job (at least 10 characters)');
    const m = urgentOk ? mode : 'scheduled';
    if (m === 'scheduled' && !when) return setError('Choose a date and time');
    if (!addressId && !geo) return setError('Choose an address or use your current location');
    setBusy(true);
    try {
      const r = await api.requests.create({
        categoryId, mode: m, description: description.trim(), scheduledFor: m === 'scheduled' ? new Date(when).toISOString() : undefined,
        addressId: addressId || undefined, location: addressId ? undefined : { lat: geo!.lat, lng: geo!.lng, source: 'gps', addressText: addressText || undefined },
        budgetHint: budget ? Number(budget).toFixed(2) : undefined, urgencyLevel: m === 'urgent' ? 'high' : undefined,
        instantAccept: m === 'urgent' && !!cat?.instantAcceptPrice,
      });
      window.location.href = `/requests/${r.id}`;
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h1 style={{ margin: 0 }}>Get quotes from local pros</h1>
      {error ? <div className="banner danger">{error}</div> : null}
      <div>
        <label htmlFor="cat">Service</label>
        <select id="cat" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
          <option value="">Choose a service…</option>
          {(cats.data ?? []).map(c => <optgroup key={c.id} label={c.name}><option value={c.id}>{c.name} (general)</option>{c.children.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}
        </select>
      </div>
      {urgentOk ? (
        <div className="seg" role="tablist">
          <button type="button" className={mode === 'urgent' ? 'on' : ''} onClick={() => setMode('urgent')}>⚡ Urgent — now</button>
          <button type="button" className={mode === 'scheduled' ? 'on' : ''} onClick={() => setMode('scheduled')}>📅 Schedule</button>
        </div>
      ) : <div className="banner">This service is booked in advance.</div>}
      {(!urgentOk || mode === 'scheduled') ? <div><label htmlFor="when">When?</label><input id="when" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} min={new Date(Date.now() + 3600_000).toISOString().slice(0, 16)} /></div> : null}
      <div><label htmlFor="desc">What needs doing?</label><textarea id="desc" value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} placeholder="e.g. Kitchen sink pipe is leaking; mains water turned off" /></div>
      <div>
        <label htmlFor="addr">Where?</label>
        {addresses.data?.length ? (
          <select id="addr" value={addressId} onChange={e => setAddressId(e.target.value)}>
            <option value="">— use my current location —</option>
            {addresses.data.map(a => <option key={a.id} value={a.id}>{a.label}: {a.line1}, {a.city}</option>)}
          </select>
        ) : null}
        {!addressId ? (
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn secondary" onClick={locate}>📍 Use my location</button>
            {geo ? <span className="faint">{geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}</span> : null}
            <input placeholder="Street / landmark (helps the pro find you)" value={addressText} onChange={e => setAddressText(e.target.value)} />
          </div>
        ) : null}
        <p className="faint">Pros only see your neighbourhood until you book and pay.</p>
      </div>
      <div><label htmlFor="budget">Budget (optional, {cfg.data?.currency ?? 'MUR'})</label><input id="budget" inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} /></div>
      {mode === 'urgent' && cat?.instantAcceptPrice ? <div className="banner">The first available pro may accept instantly at the fixed call-out price of {formatMoney(cat.instantAcceptPrice, cfg.data?.currency ?? 'MUR')}.</div> : null}
      <p className="faint">A {cfg.data?.customerFeePct ?? 15}% service fee is added to the quote you accept. Your payment is held until you approve the work.</p>
      <button className={`btn block ${mode === 'urgent' && urgentOk ? 'urgent' : ''}`} disabled={busy}>{busy ? 'Sending…' : mode === 'urgent' && urgentOk ? 'Send urgent request' : 'Get quotes'}</button>
    </form>
  );
}

export default function NewRequestPage() {
  return <main className="container" style={{ maxWidth: 640, padding: '32px 20px' }}><RequireAuth><NewRequestForm /></RequireAuth></main>;
}
