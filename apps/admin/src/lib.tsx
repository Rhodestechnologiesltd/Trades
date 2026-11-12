import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Api, ApiError, TokenPair, createApi } from '@trades/shared';

/* ───────────── API + staff session (tokens in sessionStorage: cleared when the tab closes) ───────────── */

const API_URL: string = (import.meta as any).env?.VITE_API_URL ?? (window as any).__TRADES_API__ ?? 'http://localhost:3000';
const KEY = 'trades.ops.tokens';
const store = {
  async get() { const r = sessionStorage.getItem(KEY); return r ? JSON.parse(r) : null; },
  async set(t: { accessToken: string; refreshToken: string } | null) { if (t) sessionStorage.setItem(KEY, JSON.stringify(t)); else sessionStorage.removeItem(KEY); },
};

export type StaffRole = 'admin' | 'support' | 'finance';
interface Session { api: Api; user: TokenPair['user'] | null; role: StaffRole | null; login: (p: TokenPair) => void; logout: () => void }
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<TokenPair['user'] | null>(() => {
    const r = sessionStorage.getItem('trades.ops.user');
    return r ? JSON.parse(r) : null;
  });
  const api = useMemo(() => createApi({ baseUrl: API_URL, tokens: store, onSessionEnded: () => { sessionStorage.clear(); setUser(null); } }), []);
  const login = useCallback((p: TokenPair) => {
    store.set({ accessToken: p.accessToken, refreshToken: p.refreshToken });
    sessionStorage.setItem('trades.ops.user', JSON.stringify(p.user));
    setUser(p.user);
  }, []);
  const logout = useCallback(() => { api.auth.logout().catch(() => undefined); sessionStorage.clear(); setUser(null); }, [api]);
  const role = user && ['admin', 'support', 'finance'].includes(user.type) ? (user.type as StaffRole) : null;
  return <Ctx.Provider value={{ api, user, role, login, logout }}>{children}</Ctx.Provider>;
}
export function useSession() { const c = useContext(Ctx); if (!c) throw new Error('no session'); return c; }
export const useApi = () => useSession().api;

/* ───────────── tiny hash router ───────────── */

export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
  };
  const [r, setR] = useState(read);
  useEffect(() => { const on = () => setR(read()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return r;
}
export const go = (path: string) => { window.location.hash = path; };

/* ───────────── data hook ───────────── */

export function useData<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then(d => { if (live) { setData(d); setError(null); } }).catch(e => { if (live) setError(errMsg(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [...deps, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: () => setN(x => x + 1) };
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.details && Array.isArray(e.details) ? `${e.message}` : e.message;
  return e instanceof Error ? e.message : 'Something went wrong';
}

/* ───────────── UI bits ───────────── */

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export const Pill = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) => <span className={`pill ${tone}`}>{children}</span>;
export const Banner = ({ children, tone = 'info' }: { children: ReactNode; tone?: Tone }) => <div className={`banner ${tone}`}>{children}</div>;
export const Loading = () => <div className="muted" style={{ padding: 24 }}>Loading…</div>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="row spread" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

/** Runs a mutating action with a mandatory reason prompt (every privileged action is audit-logged with a reason). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok = 'Done') => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'success', text: ok }); return true; } catch (e) { setMsg({ tone: 'danger', text: errMsg(e) }); return false; } finally { setBusy(false); }
  };
  return { busy, msg, run, setMsg };
}

export const STATUS_TONE: Record<string, Tone> = {
  payment_pending: 'warning', payment_authorized: 'info', assigned: 'info', in_progress: 'info', completed_by_provider: 'warning', approved_by_customer: 'success',
  payout_pending: 'success', payout_released: 'success', cancelled: 'neutral', disputed: 'danger', refund_pending: 'warning', refunded: 'neutral',
  opened: 'danger', under_review: 'warning', awaiting_evidence: 'warning', resolved: 'success', closed: 'neutral',
  processing: 'info', released: 'success', settled: 'success', held: 'warning', clawed_back: 'danger',
  pending: 'warning', verified: 'success', rejected: 'danger', unverified: 'neutral', open: 'danger', reviewing: 'warning', actioned: 'success', dismissed: 'neutral',
  initiated: 'warning', processed: 'success', failed: 'danger', matched: 'success', mismatch: 'danger', pending_report: 'warning',
  dispatched: 'info', quoted: 'info', accepted: 'success', expired: 'neutral', uploaded: 'info', approved: 'success',
};
export const StatusPill = ({ s }: { s: string }) => <Pill tone={STATUS_TONE[s] ?? 'neutral'}>{s.replace(/_/g, ' ')}</Pill>;
