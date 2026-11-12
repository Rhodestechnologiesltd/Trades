import { ReactNode, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banner, SessionProvider, StaffRole, errMsg, go, useRoute, useSession } from './lib';
import { Dashboard } from './pages/Dashboard';
import { Providers, ProviderDetail } from './pages/Providers';
import { Bookings, BookingDetail } from './pages/Bookings';
import { Requests } from './pages/Requests';
import { Disputes, DisputeDetail } from './pages/Disputes';
import { Payouts } from './pages/Payouts';
import { Refunds } from './pages/Refunds';
import { Ledger } from './pages/Ledger';
import { Categories } from './pages/Categories';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { Trust } from './pages/Trust';
import { Audit } from './pages/Audit';
import { Analytics } from './pages/Analytics';

const NAV: Array<{ group: string; items: Array<{ path: string; label: string; roles: StaffRole[] }> }> = [
  { group: 'Overview', items: [{ path: '/', label: 'Dashboard', roles: ['admin', 'support', 'finance'] }, { path: '/analytics', label: 'Analytics', roles: ['admin', 'finance'] }] },
  { group: 'Operations', items: [
    { path: '/requests', label: 'Requests & dispatch', roles: ['admin', 'support'] },
    { path: '/bookings', label: 'Bookings', roles: ['admin', 'support', 'finance'] },
    { path: '/disputes', label: 'Disputes', roles: ['admin', 'support', 'finance'] },
    { path: '/providers', label: 'Provider verification', roles: ['admin', 'support'] },
    { path: '/users', label: 'Users & staff', roles: ['admin', 'support'] },
  ] },
  { group: 'Finance', items: [
    { path: '/payouts', label: 'Payouts', roles: ['admin', 'finance'] },
    { path: '/refunds', label: 'Refunds', roles: ['admin', 'finance'] },
    { path: '/ledger', label: 'Ledger & reconciliation', roles: ['admin', 'finance'] },
  ] },
  { group: 'Trust & safety', items: [
    { path: '/trust', label: 'Fraud, reviews, delivery', roles: ['admin', 'support'] },
    { path: '/audit', label: 'Audit log', roles: ['admin', 'support', 'finance'] },
  ] },
  { group: 'Configuration', items: [
    { path: '/categories', label: 'Service categories', roles: ['admin', 'support', 'finance'] },
    { path: '/settings', label: 'Fees, markets & policies', roles: ['admin', 'finance'] },
  ] },
];

function Login() {
  const { api, login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login card">
      <h1>Trades Ops</h1>
      <p className="muted">Staff sign-in. Multi-factor authentication is required.</p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError(null);
        try { login(await api.auth.staffLogin({ email, password, totp, deviceId: navigator.userAgent.slice(0, 100) })); go('/'); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
      }}>
        <label htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <label htmlFor="totp">Authenticator code</label><input id="totp" inputMode="numeric" pattern="\d{6}" maxLength={6} value={totp} onChange={e => setTotp(e.target.value)} required />
        <div style={{ height: 14 }} />
        <button type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Shell() {
  const { user, role, logout } = useSession();
  const { path, parts } = useRoute();
  if (!user || !role) return <Login />;
  const top = '/' + (parts[0] ?? '');
  let page: ReactNode;
  switch (parts[0]) {
    case undefined: page = <Dashboard />; break;
    case 'analytics': page = <Analytics />; break;
    case 'providers': page = parts[1] ? <ProviderDetail id={parts[1]} /> : <Providers />; break;
    case 'bookings': page = parts[1] ? <BookingDetail id={parts[1]} /> : <Bookings />; break;
    case 'requests': page = <Requests />; break;
    case 'disputes': page = parts[1] ? <DisputeDetail id={parts[1]} /> : <Disputes />; break;
    case 'payouts': page = <Payouts />; break;
    case 'refunds': page = <Refunds />; break;
    case 'ledger': page = <Ledger />; break;
    case 'categories': page = <Categories />; break;
    case 'settings': page = <Settings />; break;
    case 'users': page = <Users />; break;
    case 'trust': page = <Trust />; break;
    case 'audit': page = <Audit />; break;
    default: page = <Banner tone="warning">Page not found: {path}</Banner>;
  }
  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main">
        <div className="logo">Trades<span>OPS</span></div>
        {NAV.map(g => {
          const items = g.items.filter(i => i.roles.includes(role));
          if (!items.length) return null;
          return (
            <div key={g.group}>
              <div className="group">{g.group}</div>
              {items.map(i => <a key={i.path} href={`#${i.path}`} className={top === i.path ? 'active' : ''}>{i.label}</a>)}
            </div>
          );
        })}
        <div className="group">Signed in</div>
        <div style={{ padding: '0 10px', fontSize: 13 }}>{user.fullName}<br /><span className="faint">{role}</span></div>
        <a href="#/" onClick={logout} style={{ marginTop: 8 }}>Sign out</a>
      </nav>
      <main className="main">{page}</main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><SessionProvider><Shell /></SessionProvider></StrictMode>);
