import { Fragment, useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, useApi, useData } from '../lib';

export function Audit() {
  const api = useApi();
  const [f, setF] = useState({ entityType: '', entityId: '', action: '' });
  const [applied, setApplied] = useState(f);
  const { data, loading, error } = useData(() => api.admin.auditLogs({ entityType: applied.entityType || undefined, entityId: applied.entityId || undefined, action: applied.action || undefined }), [applied]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="topbar"><div><h1>Audit log</h1><span className="muted">Append-only record of every privileged action and state change (§J)</span></div></div>
      <form className="card row" onSubmit={e => { e.preventDefault(); setApplied(f); }}>
        <input style={{ maxWidth: 200 }} placeholder="Entity type (booking, payout…)" value={f.entityType} onChange={e => setF({ ...f, entityType: e.target.value })} aria-label="Entity type" />
        <input style={{ maxWidth: 320 }} placeholder="Entity id" value={f.entityId} onChange={e => setF({ ...f, entityId: e.target.value })} aria-label="Entity id" />
        <input style={{ maxWidth: 220 }} placeholder="Action prefix (dispute., payout.)" value={f.action} onChange={e => setF({ ...f, action: e.target.value })} aria-label="Action" />
        <button type="submit" className="secondary">Filter</button>
      </form>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th><th>IP</th></tr></thead>
            <tbody>{data?.map((a: any) => (
              <Fragment key={a.id}>
                <tr className="click" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <td className="faint">{formatDateTime(a.occurred_at)}</td><td>{a.actor_name ?? a.actor_type}<div className="faint">{a.actor_type}</div></td>
                  <td className="mono">{a.action}</td><td className="mono">{a.entity_type}<div className="faint">{a.entity_id?.slice(0, 8)}</div></td><td>{a.reason ?? '—'}</td><td className="mono">{a.ip_address ?? '—'}</td>
                </tr>
                {open === a.id ? <tr><td colSpan={6} className="mono" style={{ background: '#fafbfc', whiteSpace: 'pre-wrap' }}>before: {JSON.stringify(a.before_state, null, 2)}{'\n'}after: {JSON.stringify(a.after_state, null, 2)}</td></tr> : null}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
