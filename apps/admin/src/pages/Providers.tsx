import { useState } from 'react';
import { formatDateTime } from '@trades/shared';
import { Banner, Loading, Modal, Pill, StatusPill, go, useAction, useApi, useData, useSession } from '../lib';

export function Providers() {
  const api = useApi();
  const [status, setStatus] = useState('pending');
  const { data, loading, error } = useData(() => api.admin.providers(status), [status]);
  return (
    <>
      <div className="topbar"><div><h1>Provider verification</h1><span className="muted">KYC review: support checks documents, an admin gives final approval (§I)</span></div></div>
      <div className="tabs">{['pending', 'unverified', 'verified', 'rejected'].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}</div>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {loading ? <Loading /> : (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Services</th><th>Background check</th><th className="num">Docs to review</th><th>Registered</th></tr></thead>
            <tbody>
              {data?.map(p => (
                <tr key={p.id} className="click" onClick={() => go(`/providers/${p.id}`)}>
                  <td><strong>{p.full_name}</strong>{p.business_name ? <div className="faint">{p.business_name}</div> : null}</td>
                  <td className="mono">{p.phone_number}</td>
                  <td>{p.categories.join(', ')}</td>
                  <td><StatusPill s={p.background_check_status} /></td>
                  <td className="num">{p.docs_to_review ? <Pill tone="warning">{p.docs_to_review}</Pill> : 0}</td>
                  <td>{formatDateTime(p.created_at, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
              {!data?.length ? <tr><td colSpan={6} className="muted">Nothing in this queue.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function ProviderDetail({ id }: { id: string }) {
  const api = useApi();
  const { role } = useSession();
  const { data: p, loading, error, reload } = useData(() => api.admin.provider(id), [id]);
  const act = useAction();
  const [reject, setReject] = useState<{ docId?: string } | null>(null);
  const [reason, setReason] = useState('');
  const [statusModal, setStatusModal] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (error || !p) return <Banner tone="danger">{error}</Banner>;

  return (
    <>
      <div className="topbar">
        <div><a href="#/providers">← Providers</a><h1>{p.full_name}</h1><span className="muted">{p.business_name ?? ''} · {p.phone_number} · {p.email ?? 'no email'}</span></div>
        <div className="row">
          <StatusPill s={p.verification_status} />
          {role === 'admin' && p.verification_status !== 'verified' ? <button disabled={act.busy} onClick={() => act.run(() => api.admin.decideVerification(id, 'approve'), 'Provider approved').then(reload)}>Approve provider</button> : null}
          {p.verification_status !== 'rejected' ? <button className="danger" onClick={() => setReject({})}>Reject…</button> : null}
          {role === 'admin' ? <button className="secondary" onClick={() => setStatusModal(p.user_status === 'active' ? 'suspended' : 'active')}>{p.user_status === 'active' ? 'Suspend' : 'Reinstate'}</button> : null}
        </div>
      </div>
      {act.msg ? <Banner tone={act.msg.tone}>{act.msg.text}</Banner> : null}
      <div className="grid c2">
        <div className="card">
          <h2>Documents</h2>
          {!p.documents.length ? <p className="muted">No documents uploaded.</p> : null}
          {p.documents.map((d: any) => (
            <div key={d.id} className="row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
              {d.url && !/\.pdf/.test(d.storage_key) ? <a href={d.url} target="_blank" rel="noreferrer"><img className="doc-thumb" src={d.url} alt={d.kind} /></a> : <a className="doc-thumb row" style={{ justifyContent: 'center' }} href={d.url ?? '#'} target="_blank" rel="noreferrer">Open PDF</a>}
              <div style={{ flex: 1 }}>
                <strong>{d.kind.replace(/_/g, ' ')}</strong> <StatusPill s={d.status} />
                <div className="faint">Uploaded {formatDateTime(d.created_at)}{d.expires_at ? ` · expires ${d.expires_at}` : ''}</div>
                {d.notes ? <div className="faint">Note: {d.notes}</div> : null}
                {d.status === 'uploaded' ? (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="small" onClick={() => act.run(() => api.admin.reviewDocument(d.id, 'approved'), 'Document approved').then(reload)}>Approve</button>
                    <button className="small danger" onClick={() => setReject({ docId: d.id })}>Reject</button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <p className="faint">Document access is logged (sensitive access log).</p>
        </div>
        <div>
          <div className="card">
            <h2>Profile</h2>
            <div className="kv">
              <div>Bio</div><div>{p.bio ?? '—'}</div>
              <div>Experience</div><div>{p.years_experience ?? '—'} years</div>
              <div>Background check</div><div><StatusPill s={p.background_check_status} /></div>
              <div>Availability</div><div>{p.availability_status} · {p.current_active_jobs}/{p.max_concurrent_jobs} jobs</div>
              <div>Rating</div><div>{p.rating_avg ?? '—'} ({p.rating_count})</div>
              <div>No-shows</div><div>{p.no_show_count}</div>
              <div>Quotes</div><div>{p.quotes_accepted}/{p.quotes_submitted} accepted</div>
              <div>Bookings</div><div>{p.stats.bookings} · {p.stats.disputed} disputed · {p.stats.provider_cancellations} cancelled by provider</div>
              <div>Home base</div><div className="mono">{p.home_base_lat?.toFixed(4)}, {p.home_base_lng?.toFixed(4)}</div>
              <div>Zones</div><div>{p.zones.map((z: any) => `${z.zone_type} ${z.radius_meters ? `${z.radius_meters / 1000} km` : ''}`).join(', ')}</div>
            </div>
          </div>
          <div className="card">
            <h2>Services</h2>
            <table><tbody>{p.categories.map((c: any) => <tr key={c.category_id}><td>{c.name}</td><td>{c.requires_license ? (c.approved ? <Pill tone="success">licence approved</Pill> : <Pill tone="warning">licence pending</Pill>) : null}</td></tr>)}</tbody></table>
          </div>
          <div className="card">
            <h2>Fraud signals</h2>
            {!p.fraudSignals.length ? <p className="muted">None.</p> : (
              <table><tbody>{p.fraudSignals.map((f: any) => <tr key={f.id}><td>{f.signal}</td><td>sev {f.severity}</td><td><StatusPill s={f.status} /></td><td className="faint">{formatDateTime(f.created_at)}</td></tr>)}</tbody></table>
            )}
          </div>
        </div>
      </div>
      {reject ? (
        <Modal title={reject.docId ? 'Reject document' : 'Reject provider'} onClose={() => setReject(null)}>
          <label>Reason (shown to the provider)</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. ID photo is blurry — please retake in good light" />
          <div style={{ height: 12 }} />
          <button className="danger" disabled={reason.trim().length < 5 || act.busy} onClick={async () => {
            const ok = reject.docId ? await act.run(() => api.admin.reviewDocument(reject.docId!, 'rejected', reason), 'Document rejected') : await act.run(() => api.admin.decideVerification(id, 'reject', reason), 'Provider rejected');
            if (ok) { setReject(null); setReason(''); reload(); }
          }}>Reject</button>
        </Modal>
      ) : null}
      {statusModal ? (
        <Modal title={statusModal === 'active' ? 'Reinstate account' : 'Suspend account'} onClose={() => setStatusModal(null)}>
          <label>Reason (audit-logged)</label><textarea value={reason} onChange={e => setReason(e.target.value)} />
          <div style={{ height: 12 }} />
          <button className={statusModal === 'active' ? '' : 'danger'} disabled={reason.trim().length < 3} onClick={async () => { if (await act.run(() => api.admin.setUserStatus(id, statusModal, reason))) { setStatusModal(null); setReason(''); reload(); } }}>Confirm</button>
        </Modal>
      ) : null}
    </>
  );
}
