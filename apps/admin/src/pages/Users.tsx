import { useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, Modal, StatusPill, go, useAction, useApi, useData, useSession } from '../lib';

export function Users() {
  const api = useApi();
  const { role } = useSession();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const { data, loading, error, reload } = useData(() => api.admin.users(search || undefined, type || undefined), [search, type]);
  const act = useAction();
  const [target, setTarget] = useState<{ id: string; name: string; status: string } | null>(null);
  const [reason, setReason] = useState('');
  const [staff, setStaff] = useState(false);
  const [sf, setSf] = useState({ email: '', fullName: '', role: 'support', password: '' });
  const [provision, setProvision] = useState<string | null>(null);
  return (
    <>
      <div className="topbar">
        <div><h1>Users & staff</h1><span className="muted">Suspend / ban revokes all sessions immediately</span></div>
        {role === 'admin' ? <button onClick={() => setStaff(true)}>Add staff member</button> : null}
      </div>
      <div className="card row">
        <form className="row" style={{ flex: 1 }} onSubmit={e => { e.preventDefault(); setSearch(q); }}>
          <input style={{ maxWidth: 320 }} placeholder="Name, phone or email" value={q} onChange={e => setQ(e.target.value)} aria-label="Search users" /><button className="secondary" type="submit">Search</button>
        </form>
        <select style={{ maxWidth: 200 }} value={type} onChange={e => setType(e.target.value)} aria-label="User type">{['', 'customer', 'provider', 'admin', 'support', 'finance'].map(t => <option key={t} value={t}>{t || 'All types'}</option>)}</select>
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      {provision ? <Banner tone="warning">Share this MFA provisioning URI with the new staff member securely (shown once): <span className="mono">{provision}</span></Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Type</th><th>Status</th><th>Joined</th><th>Last login</th><th></th></tr></thead>
            <tbody>{data?.map(u => (
              <tr key={u.id}>
                <td>{u.user_type === 'provider' ? <a href={`#/providers/${u.id}`} onClick={e => { e.preventDefault(); go(`/providers/${u.id}`); }}>{u.full_name}</a> : u.full_name}</td>
                <td className="mono">{u.phone_number ?? '—'}</td><td>{u.email ?? '—'}</td><td>{u.user_type}</td><td><StatusPill s={u.status} /></td>
                <td>{formatDateTime(u.created_at, { dateStyle: 'medium' })}</td><td>{u.last_login_at ? formatDateTime(u.last_login_at) : '—'}</td>
                <td>{role === 'admin' ? <button className="small secondary" onClick={() => setTarget({ id: u.id, name: u.full_name, status: u.status })}>Change status</button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {target ? (
        <Modal title={`Account status — ${target.name}`} onClose={() => setTarget(null)}>
          <p className="muted">Currently: {target.status}</p>
          <label>Reason (audit-logged)</label><textarea value={reason} onChange={e => setReason(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            {(['active', 'suspended', 'banned'] as const).filter(s => s !== target.status).map(s => (
              <button key={s} className={s === 'active' ? '' : 'danger'} disabled={reason.length < 3} onClick={async () => { if (await act.run(() => api.admin.setUserStatus(target.id, s, reason), `Account ${s}`)) { setTarget(null); setReason(''); reload(); } }}>{s === 'active' ? 'Reinstate' : s === 'suspended' ? 'Suspend' : 'Ban'}</button>
            ))}
          </div>
        </Modal>
      ) : null}
      {staff ? (
        <Modal title="Add staff member" onClose={() => setStaff(false)}>
          <label>Email</label><input type="email" value={sf.email} onChange={e => setSf({ ...sf, email: e.target.value })} />
          <label>Full name</label><input value={sf.fullName} onChange={e => setSf({ ...sf, fullName: e.target.value })} />
          <label>Role</label><select value={sf.role} onChange={e => setSf({ ...sf, role: e.target.value })}><option value="support">Support agent</option><option value="finance">Finance operator</option><option value="admin">Admin</option></select>
          <label>Initial password (min 12 chars)</label><input type="password" value={sf.password} onChange={e => setSf({ ...sf, password: e.target.value })} />
          <div style={{ height: 12 }} />
          <button disabled={sf.password.length < 12 || !sf.email} onClick={async () => {
            let uri: string | null = null;
            if (await act.run(async () => { const r: any = await api.admin.createStaff(sf); uri = r.mfaProvisioningUri; }, 'Staff member created')) { setProvision(uri); setStaff(false); reload(); }
          }}>Create</button>
        </Modal>
      ) : null}
    </>
  );
}
