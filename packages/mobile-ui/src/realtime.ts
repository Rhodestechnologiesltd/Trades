import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import * as SecureStore from 'expo-secure-store';
import { API_URL, queryClient } from './session';

let socket: Socket | null = null;

/**
 * Live updates over WSS (§B.1). Every server event simply invalidates the matching
 * React Query caches, so screens refetch authoritative data — sockets never carry
 * state the app trusts on their own.
 */
export function useRealtime(enabled: boolean, onEvent?: (event: string, data: any) => void) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const raw = await SecureStore.getItemAsync('trades.tokens');
      if (!raw || cancelled) return;
      const { accessToken } = JSON.parse(raw);
      socket = io(API_URL, { path: '/realtime', transports: ['websocket'], auth: { token: accessToken }, reconnectionDelayMax: 10_000 });
      socket.onAny((event: string, data: any) => {
        if (event.startsWith('quote') || event.startsWith('counter_offer') || event.startsWith('request') || event.startsWith('dispatch')) {
          queryClient.invalidateQueries({ queryKey: ['request'] });
          queryClient.invalidateQueries({ queryKey: ['requests'] });
          queryClient.invalidateQueries({ queryKey: ['jobs'] });
        }
        if (data?.bookingId) queryClient.invalidateQueries({ queryKey: ['booking', data.bookingId] });
        queryClient.invalidateQueries({ queryKey: ['bookings'] });
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
        onEvent?.(event, data);
      });
      socket.on('connect_error', async () => {
        // token may have rotated — reconnect with the latest one
        const r = await SecureStore.getItemAsync('trades.tokens');
        if (r && socket) socket.auth = { token: JSON.parse(r).accessToken };
      });
    })();
    return () => { cancelled = true; socket?.disconnect(); socket = null; };
  }, [enabled]);
}

export function subscribeBooking(bookingId: string) {
  socket?.emit('booking:subscribe', { bookingId });
}

export function onSocket(event: string, fn: (data: any) => void): () => void {
  socket?.on(event, fn);
  return () => { socket?.off(event, fn); };
}
