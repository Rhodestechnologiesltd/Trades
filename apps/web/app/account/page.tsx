'use client';
import { useState } from 'react';
import { RequireAuth, msg, useAsync, useSession } from '../../src/client';

function Account() {
  const { api, me, refresh } = useSession();
  const addresses = useAsync(() => api.addresses.list(), []);
  const sessions = useAsync(() => api.auth.sessions(), []);
  const [name, setName] = useState(me?.full_name ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [note, setNote] = useState<string | null>(null);
  const [addr, setAddr] = useState({ label: 'Home', line1: '', city: '', lat: 0, lng: 0 });
  return (
    <div className="stack">
      <h1>Account</h1>
      {note ? <div className="banner">{note}</div> : null}
      <div className="card">
        <label>Name</label><input value={name} onChange={e => setName(e.target.value)} />
        <label>Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        <div style={{ height: 10 }} />
        <button className="btn" onClick={async () => { try { await api.me.update({ fullName: name, email: email || undefined }); await refresh(); setNote('Saved'); } catch (e) { setNote(msg(e)); } }}>Save</button>
      </div>
      <div className="card stack">
        <strong>Saved addresses</strong>
        {addresses.data?.map(a => <div key={a.id} className="row spread"><span>{a.label}: {a.line1}, {a.city}</span><button className="btn ghost" onClick={async () => { await api.addresses.remove(a.id); addresses.reload(); }}>Remove</button></div>)}
        <div className="grid two">
          <input placeholder="Label" value={addr.label} onChange={e => setAddr({ ...addr, label: e.target.value })} />
          <input placeholder="Town" value={addr.city} onChange={e => setAddr({ ...addr, city: e.target.value })} />
        </div>
        <input placeholder="Street address" value={addr.line1} onChange={e => setAddr({ ...addr, line1: e.target.value })} />
        <div className="row">
          <button className="btn secondary" onClick={() => navigator.geolocation.getCurrentPosition(p => setAddr(a => ({ ...a, lat: p.coords.latitude, lng: p.coords.longitude })))}>📍 Set location from this device</button>
          {addr.lat ? <span className="faint">{addr.lat.toFixed(5)}, {addr.lng.toFixed(5)}</span> : null}
          <button className="btn" disabled={!addr.line1 || !addr.city || !addr.lat} onClick={async () => { try { await api.addresses.create(addr); addresses.reload(); setAddr({ label: 'Home', line1: '', city: '', lat: 0, lng: 0 }); } catch (e) { setNote(msg(e)); } }}>Add address</button>
        </div>
      </div>
      <div className="card stack">
        <strong>Signed-in devices</strong>
        {sessions.data?.map(s => <div key={s.id} className="row spread"><span>{s.device_name ?? s.platform ?? 'Device'}{s.current ? ' (this one)' : ''}</span>{!s.current ? <button className="btn ghost" onClick={async () => { await api.auth.revokeSession(s.id); sessions.reload(); }}>Sign out</button> : null}</div>)}
      </div>
    </div>
  );
}

export default function Page() { return <main className="container" style={{ maxWidth: 680, padding: '32px 20px' }}><RequireAuth><Account /></RequireAuth></main>; }
