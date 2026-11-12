import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Api, ApiError, Me, TokenPair, createApi } from '@trades/shared';

const TOKENS_KEY = 'trades.tokens';
const DEVICE_KEY = 'trades.device';

export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as any)?.apiUrl ?? 'http://localhost:3000';

/** Tokens live in the OS keychain/keystore (§B.2 "local secure store for auth tokens"). */
const tokenStore = {
  async get() {
    const raw = await SecureStore.getItemAsync(TOKENS_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  async set(t: { accessToken: string; refreshToken: string } | null) {
    if (t) await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(t));
    else await SecureStore.deleteItemAsync(TOKENS_KEY);
  },
};

export async function deviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = `${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  return id;
}

interface SessionCtx {
  api: Api;
  me: Me | null;
  ready: boolean;
  signIn: (pair: TokenPair) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<Me | null>;
}

const Ctx = createContext<SessionCtx | null>(null);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export function SessionProvider({ children, app }: { children: React.ReactNode; app: 'customer' | 'provider' }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const api = useMemo(() => createApi({ baseUrl: API_URL, tokens: tokenStore, onSessionEnded: () => { setMe(null); queryClient.clear(); } }), []);

  const refreshMe = useCallback(async () => {
    try {
      const m = await api.me.get();
      if (m.user_type !== app) { await tokenStore.set(null); setMe(null); return null; }
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { await tokenStore.set(null); setMe(null); }
      return null;
    }
  }, [api, app]);

  useEffect(() => {
    (async () => {
      if (await tokenStore.get()) await refreshMe();
      setReady(true);
    })();
  }, [refreshMe]);

  const signIn = useCallback(async (pair: TokenPair) => {
    await tokenStore.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    await refreshMe();
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* offline: still clear local session */ }
    await tokenStore.set(null);
    queryClient.clear();
    setMe(null);
  }, [api]);

  const value = useMemo(() => ({ api, me, ready, signIn, signOut, refreshMe }), [api, me, ready, signIn, signOut, refreshMe]);
  return (
    <QueryClientProvider client={queryClient}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </QueryClientProvider>
  );
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession must be used inside <SessionProvider>');
  return c;
}

export const useApi = () => useSession().api;

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message.includes('Network request failed') ? 'No connection. Check your internet and try again.' : e.message;
  return 'Something went wrong';
}

/** API client usable outside React (background location task, headless push handlers). */
let standalone: Api | null = null;
export function standaloneApi(): Api {
  standalone ??= createApi({ baseUrl: API_URL, tokens: tokenStore });
  return standalone;
}
