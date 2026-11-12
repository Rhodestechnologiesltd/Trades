import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { standaloneApi } from '@trades/mobile-ui';

export const LOCATION_TASK = 'trades-provider-location';
let activeBookingId: string | null = null;

/**
 * Background location while ONLINE (§B.2 battery-aware throttling): ~every 60 s / 100 m
 * normally, every 15 s / 25 m during an active job so the customer sees live ETA.
 * Pings carry the OS "mocked" flag; the server rejects implausible jumps (§J).
 */
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const locations: Array<{ coords: { latitude: number; longitude: number; accuracy: number | null }; mocked?: boolean; timestamp: number }> = data.locations ?? [];
  const last = locations[locations.length - 1];
  if (!last) return;
  try {
    await standaloneApi().providers.ping({
      lat: last.coords.latitude, lng: last.coords.longitude, accuracyM: last.coords.accuracy ?? undefined, isMocked: !!last.mocked,
      recordedAt: new Date(last.timestamp).toISOString(), bookingId: activeBookingId ?? undefined,
    });
  } catch { /* offline — next update retries */ }
});

export async function startTracking(mode: 'idle' | 'job' = 'idle', bookingId?: string): Promise<boolean> {
  activeBookingId = bookingId ?? null;
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    // Foreground-only fallback: one ping now; jobs still arrive via push.
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await standaloneApi().providers.ping({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? undefined, isMocked: !!pos.mocked }).catch(() => undefined);
    return false;
  }
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: mode === 'job' ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: mode === 'job' ? 15_000 : 60_000,
    distanceInterval: mode === 'job' ? 25 : 100,
    deferredUpdatesInterval: mode === 'job' ? 15_000 : 120_000,
    pausesUpdatesAutomatically: mode !== 'job',
    showsBackgroundLocationIndicator: true,
    foregroundService: { notificationTitle: 'Trades Pro is online', notificationBody: 'Receiving nearby jobs', notificationColor: '#0E7C66' },
  });
  return true;
}

export async function stopTracking() {
  activeBookingId = null;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

export async function currentPosition(): Promise<{ lat: number; lng: number; accuracyM?: number } | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy ?? undefined };
}
