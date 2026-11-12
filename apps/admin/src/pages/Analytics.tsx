import { useState } from 'react';
import { formatMoney } from '@trades/shared';
import { Banner, Loading, useApi, useData } from '../lib';

export function Analytics() {
  const api = useApi();
  const [days, setDays] = useState(30);
  const funnel = useData(() => api.admin.analytics('funnel', days), [days]);
  const demand = useData(() => api.admin.analytics('category-demand', days), [days]);
  const util = useData(() => api.admin.analytics('provider-utilization', days), [days]);
  const heat = useData(() => api.admin.analytics('heatmap', days), [days]);
  const f = funnel.data;
  const steps: Array<[string, number]> = f ? [['Requests', f.requests], ['Dispatched', f.dispatched], ['Quoted', f.quoted], ['Accepted', f.accepted], ['Paid', f.paid], ['Completed', f.completed]] : [];
  return (
    <>
      <div className="topbar">
        <div><h1>Analytics</h1><span className="muted">Funnel, category demand, unmet demand by area, provider performance</span></div>
        <select style={{ maxWidth: 160 }} value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}</select>
      </div>
      {funnel.error ? <Banner tone="danger">{funnel.error}</Banner> : null}
      <div className="card">
        <h2>Conversion funnel</h2>
        {funnel.loading ? <Loading /> : steps.map(([label, n], i) => (
          <div key={label} className="row" style={{ marginBottom: 6 }}>
            <div style={{ width: 110 }}>{label}</div>
            <div style={{ flex: 1, background: 'var(--neutral-soft)', borderRadius: 6 }}><div style={{ width: `${steps[0][1] ? (n / steps[0][1]) * 100 : 0}%`, background: 'var(--brand)', height: 22, borderRadius: 6 }} /></div>
            <div style={{ width: 120 }} className="num">{n}{i > 0 && steps[i - 1][1] ? <span className="faint"> ({Math.round((n / steps[i - 1][1]) * 100)}%)</span> : null}</div>
          </div>
        ))}
      </div>
      <div className="grid c2">
        <div className="card">
          <h2>Category demand</h2>
          {demand.loading ? <Loading /> : (
            <table><thead><tr><th>Category</th><th>Mode</th><th className="num">Requests</th><th className="num">Avg accepted</th><th className="num">Unfilled</th></tr></thead>
              <tbody>{(demand.data ?? []).map((d: any, i: number) => <tr key={i}><td>{d.name}</td><td>{d.request_mode}</td><td className="num">{d.requests}</td><td className="num">{d.avg_quote ? formatMoney(d.avg_quote, 'MUR') : '—'}</td><td className="num">{d.expired_pct}%</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="card">
          <h2>Unmet demand hotspots (~1 km grid)</h2>
          {heat.loading ? <Loading /> : (
            <table><thead><tr><th>Area (lat, lng)</th><th className="num">Requests</th><th className="num">Unmet</th></tr></thead>
              <tbody>{(heat.data ?? []).filter((h: any) => h.unmet > 0).slice(0, 25).map((h: any, i: number) => <tr key={i}><td className="mono"><a href={`https://www.google.com/maps?q=${h.lat},${h.lng}`} target="_blank" rel="noreferrer">{h.lat}, {h.lng}</a></td><td className="num">{h.requests}</td><td className="num">{h.unmet}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Provider performance</h2>
        {util.loading ? <Loading /> : (
          <table><thead><tr><th>Provider</th><th className="num">Jobs</th><th className="num">Rating</th><th className="num">Quote conversion</th><th className="num">Avg response</th><th className="num">No-shows</th></tr></thead>
            <tbody>{(util.data ?? []).map((p: any) => <tr key={p.id}><td><a href={`#/providers/${p.id}`}>{p.full_name}</a></td><td className="num">{p.jobs}</td><td className="num">{p.rating_avg ?? '—'}</td><td className="num">{p.conversion_pct ?? '—'}%</td><td className="num">{p.response_speed_avg_sec ? `${Math.round(p.response_speed_avg_sec / 60)} min` : '—'}</td><td className="num">{p.no_show_count}</td></tr>)}</tbody></table>
        )}
      </div>
    </>
  );
}
