import { useState } from 'react';
import { formatMoney } from '@trades/shared';
import { Banner, Loading, Modal, Pill, useAction, useApi, useData, useSession } from '../lib';

type Cat = Record<string, any>;
const EMPTY: Cat = { name: '', slug: '', icon: 'construct', parent_id: '', requires_license: false, requires_background_check: false, urgency_allowed: true, average_job_duration_min: 90,
  customer_fee_bps: '', provider_commission_bps: '', price_floor: '', price_ceiling: '', instant_accept_price: '', max_negotiation_rounds: '', is_active: true, sort_order: 100 };

export function Categories() {
  const api = useApi();
  const { role } = useSession();
  const { data, loading, error, reload } = useData(() => api.admin.categories(), []);
  const act = useAction();
  const [edit, setEdit] = useState<Cat | null>(null);
  const [reason, setReason] = useState('');

  const flat: Cat[] = (data ?? []).flatMap((c: Cat) => [c, ...c.children.map((s: Cat) => ({ ...s, _child: true }))]);
  const open = (c?: Cat) => setEdit(c ? {
    id: c.id, name: c.name, slug: c.slug, icon: c.icon ?? '', parent_id: c.parentId ?? '', requires_license: c.requiresLicense, requires_background_check: c.requiresBackgroundCheck,
    urgency_allowed: c.urgencyAllowed, average_job_duration_min: c.averageJobDurationMin, customer_fee_bps: c.customerFeeBps ?? '', provider_commission_bps: c.providerCommissionBps ?? '',
    price_floor: c.priceFloor ?? '', price_ceiling: c.priceCeiling ?? '', instant_accept_price: c.instantAcceptPrice ?? '', max_negotiation_rounds: c.maxNegotiationRounds ?? '', is_active: c.isActive,
  } : { ...EMPTY });

  async function save() {
    if (!edit) return;
    const { id, ...rest } = edit;
    const body: Record<string, unknown> = { reason };
    for (const [k, v] of Object.entries(rest)) {
      if (['customer_fee_bps', 'provider_commission_bps', 'max_negotiation_rounds', 'average_job_duration_min', 'sort_order'].includes(k)) body[k] = v === '' ? null : Number(v);
      else if (['price_floor', 'price_ceiling', 'instant_accept_price', 'parent_id'].includes(k)) body[k] = v === '' ? null : String(v);
      else body[k] = v;
    }
    if (body.parent_id === null) delete body.parent_id;
    const ok = await act.run(() => (id ? api.admin.updateCategory(id, body) : api.admin.createCategory(body)), 'Category saved');
    if (ok) { setEdit(null); setReason(''); reload(); }
  }

  return (
    <>
      <div className="topbar">
        <div><h1>Service categories</h1><span className="muted">Admin-managed taxonomy — new trades need no deploy (§A.2)</span></div>
        {role === 'admin' ? <button onClick={() => open()}>New category</button> : null}
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Rules</th><th className="num">Fee / commission</th><th className="num">Floor – ceiling</th><th className="num">Instant price</th><th>Status</th><th></th></tr></thead>
            <tbody>{flat.map(c => (
              <tr key={c.id}>
                <td style={{ paddingLeft: c._child ? 32 : 10 }}>{c._child ? '↳ ' : ''}<strong>{c.name}</strong> <span className="faint mono">{c.slug}</span></td>
                <td className="row">{c.requiresLicense ? <Pill tone="warning">licence</Pill> : null}{c.requiresBackgroundCheck ? <Pill tone="warning">background check</Pill> : null}{c.urgencyAllowed ? <Pill tone="info">urgent ok</Pill> : <Pill>scheduled only</Pill>}</td>
                <td className="num">{c.customerFeeBps != null || c.providerCommissionBps != null ? `${(c.customerFeeBps ?? 0) / 100}% / ${(c.providerCommissionBps ?? 0) / 100}%` : <span className="faint">default</span>}</td>
                <td className="num">{c.priceFloor || c.priceCeiling ? `${c.priceFloor ?? '—'} – ${c.priceCeiling ?? '—'}` : '—'}</td>
                <td className="num">{c.instantAcceptPrice ? formatMoney(c.instantAcceptPrice, 'MUR') : '—'}</td>
                <td>{c.isActive ? <Pill tone="success">active</Pill> : <Pill>hidden</Pill>}</td>
                <td>{role === 'admin' ? <button className="small secondary" onClick={() => open(c)}>Edit</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {edit ? (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New category'} onClose={() => setEdit(null)}>
          <div className="grid c2" style={{ gap: 8 }}>
            <div><label>Name</label><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label>Slug</label><input value={edit.slug} onChange={e => setEdit({ ...edit, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></div>
            <div><label>Parent</label><select value={edit.parent_id} onChange={e => setEdit({ ...edit, parent_id: e.target.value })}><option value="">— top level —</option>{(data ?? []).map((c: Cat) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label>Icon (Ionicons name)</label><input value={edit.icon} onChange={e => setEdit({ ...edit, icon: e.target.value })} /></div>
            <div><label>Customer fee override (bps, 1500 = 15%)</label><input value={edit.customer_fee_bps} onChange={e => setEdit({ ...edit, customer_fee_bps: e.target.value })} placeholder="inherit" /></div>
            <div><label>Provider commission override (bps)</label><input value={edit.provider_commission_bps} onChange={e => setEdit({ ...edit, provider_commission_bps: e.target.value })} placeholder="inherit" /></div>
            <div><label>Hard price floor</label><input value={edit.price_floor} onChange={e => setEdit({ ...edit, price_floor: e.target.value })} /></div>
            <div><label>Hard price ceiling</label><input value={edit.price_ceiling} onChange={e => setEdit({ ...edit, price_ceiling: e.target.value })} /></div>
            <div><label>Instant-accept call-out price</label><input value={edit.instant_accept_price} onChange={e => setEdit({ ...edit, instant_accept_price: e.target.value })} /></div>
            <div><label>Max negotiation rounds</label><input value={edit.max_negotiation_rounds} onChange={e => setEdit({ ...edit, max_negotiation_rounds: e.target.value })} placeholder="platform default" /></div>
            <div><label>Average job duration (min)</label><input value={edit.average_job_duration_min} onChange={e => setEdit({ ...edit, average_job_duration_min: e.target.value })} /></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {(['requires_license', 'requires_background_check', 'urgency_allowed', 'is_active'] as const).map(k => (
              <label key={k} className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!edit[k]} onChange={e => setEdit({ ...edit, [k]: e.target.checked })} /> {k.replace(/_/g, ' ')}</label>
            ))}
          </div>
          <label>Reason for change (audit-logged)</label><input value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button disabled={!edit.name || !edit.slug || reason.length < 3 || act.busy} onClick={save}>Save</button>
        </Modal>
      ) : null}
    </>
  );
}
