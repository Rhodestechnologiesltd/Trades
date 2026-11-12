'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Api, ApiError, Me, TokenPair, createApi } from '@trades/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/*
 * Web session. Tokens are kept in localStorage for this SPA-style flow; for production
 * hardening, front the API with a same-site BFF that sets httpOnly cookies (§B.2 BFF layer).
 */
const KEY = 'trades.web.tokens';
const store = {
  async get() { try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; } catch { return null; } },
  async set(t: { accessToken: string; refreshToken: string } | null) { try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

interface Ctx { api: Api; me: Me | null; ready: boolean; signIn: (p: TokenPair) => Promise<Me | null>; signOut: () => Promise<void>; refresh: () => Promise<Me | null> }
const C = createContext<Ctx | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const api = useMemo(() => createApi({ baseUrl: API_URL, tokens: store, onSessionEnded: () => setMe(null) }), []);
  const refresh = useCallback(async () => {
    try { const m = await api.me.get(); setMe(m); return m; } catch { setMe(null); return null; }
  }, [api]);
  useEffect(() => { (async () => { if (await store.get()) await refresh(); setReady(true); })(); }, [refresh]);
  const signIn = useCallback(async (p: TokenPair) => { await store.set({ accessToken: p.accessToken, refreshToken: p.refreshToken }); return refresh(); }, [refresh]);
  const signOut = useCallback(async () => { await api.auth.logout().catch(() => undefined); await store.set(null); setMe(null); }, [api]);
  return <C.Provider value={{ api, me, ready, signIn, signOut, refresh }}>{children}</C.Provider>;
}

export function useSession(): Ctx { const c = useContext(C); if (!c) throw new Error('Providers missing'); return c; }

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { pollMs?: number; enabled?: boolean } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (opts.enabled === false) return;
    let live = true;
    const run = () => fn().then(d => { if (live) { setData(d); setError(null); } }).catch(e => { if (live) setError(msg(e)); });
    run();
    const t = opts.pollMs ? setInterval(run, opts.pollMs) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
  }, [...deps, n, opts.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setN(x => x + 1) };
}

export const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');

export function RequireAuth({ children, role = 'customer' }: { children: ReactNode; role?: 'customer' | 'provider' }) {
  const { me, ready } = useSession();
  useEffect(() => {
    if (ready && !me) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}${role === 'provider' ? '&as=provider' : ''}`;
  }, [ready, me, role]);
  if (!ready || !me) return <p className="muted">Loading…</p>;
  if (me.user_type !== role) return <div className="banner warning">This page is for {role === 'provider' ? 'service providers' : 'customers'}. You are signed in as a {me.user_type}.</div>;
  return <>{children}</>;
}

export function Header() {
  const { me, signOut } = useSession();
  return (
    <header className="site">
      <div className="container">
        <a className="logo" href="/">Trades</a>
        <nav>
          <a href="/#services">Services</a>
          {me?.user_type === 'provider' ? <a href="/pro">Pro portal</a> : <a href="/pro">For pros</a>}
          {me ? <>{me.user_type === 'customer' ? <a href="/requests">My jobs</a> : null}<a href="/account">{me.full_name.split(' ')[0]}</a><button className="btn ghost" onClick={() => signOut().then(() => (window.location.href = '/'))}>Sign out</button></>
            : <a className="btn" href="/login">Sign in</a>}
        </nav>
      </div>
    </header>
  );
}
