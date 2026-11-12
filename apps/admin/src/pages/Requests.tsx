import { useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, Modal, Pill, StatusPill, useAction, useApi, useData, useRoute } from '../lib';

export function Requests() {
  const api = useApi();
  const { query } = useRoute();
  const [assist, setAssist] = useState(query.get('assist') === '1');
  const [status, setStatus] = useState('');
  const { data, loading, error, reload } = useData(() => api.admin.requests({ status: status || undefined, adminAssist: assist }), [status, assist]);
  const act = useAction();
  const [log, setLog] = useState<{ id: string; rows: any[] } | null>(null);
  return (
    <>
      <div className="topbar"><div><h1>Requests & dispatch</h1><span className="muted">Matching, radius expansion and manual assist for urgent requests (§G.2)</span></div></div>
      <div className="card row">
        <label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={assist} onChange={e => setAssist(e.target.checked)} /> Needs manual assist only</label>
        <select style={{ maxWidth: 220 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">{['', 'requested', 'matching', 'dispatched', 'quoted', 'accepted', 'expired', 'cancelled'].map(s => <option key={s} value={s}>{s || 'All statuses'}</option>)}</select>
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Request</th><th>Customer</th><th>Area</th><th>Mode</th><th>Status</th><th className="num">Radius</th><th className="num">Notified</th><th className="num">Quotes</th><th>Created</th><th></th></tr></thead>
            <tbody>{data?.map(r => (
              <tr key={r.id}>
                <td><strong>{r.title}</strong><div className="faint">{r.category}</div></td>
                <td>{r.customer_name}</td><td>{r.area_label ?? '—'}</td>
                <td>{r.request_mode === 'urgent' ? <Pill tone="danger">urgent</Pill> : r.request_mode}</td>
                <td><StatusPill s={r.status} />{r.admin_assist_requested ? <> <Pill tone="danger">assist</Pill></> : null}</td>
                <td className="num">{(r.current_search_radius_m / 1000).toFixed(1)} km</td><td className="num">{r.notified} (w{r.dispatch_wave})</td><td className="num">{r.quotes}</td>
                <td>{formatDateTime(r.created_at)}</td>
                <td className="row">
                  <button className="small secondary" onClick={async () => setLog({ id: r.id, rows: await api.admin.dispatchLog(r.id) })}>Log</button>
                  {['dispatched', 'quoted', 'requested'].includes(r.status) ? <button className="small" disabled={act.busy} onClick={() => act.run(() => api.admin.redispatch(r.id), 'Next dispatch wave sent').then(reload)}>Re-dispatch</button> : null}
                </td>
              </tr>
            ))}{!data?.length ? <tr><td colSpan={10} className="muted">No requests.</td></tr> : null}</tbody>
          </table>
        </div>
      )}
      {log ? (
        <Modal title="Dispatch log" onClose={() => setLog(null)}>
          <table><thead><tr><th>Provider</th><th>Wave</th><th className="num">Score</th><th className="num">km</th><th>Status</th><th>Notified</th></tr></thead>
            <tbody>{log.rows.map(d => <tr key={d.id}><td>{d.full_name}</td><td>{d.wave}</td><td className="num">{d.rank_score ? Number(d.rank_score).toFixed(3) : '—'}</td><td className="num">{(d.distance_m / 1000).toFixed(1)}</td><td><StatusPill s={d.status} /></td><td className="faint">{formatDateTime(d.notified_at)}</td></tr>)}</tbody></table>
          {!log.rows.length ? <p className="muted">No providers were eligible.</p> : null}
        </Modal>
      ) : null}
    </>
  );
}
