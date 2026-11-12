/**
 * Geolocation & dispatch rules (spec §G). Hard filters (zone containment,
 * category, verification, availability, workload) run in SQL; this module owns
 * the policy numbers and the ranking/wave logic so they are unit-testable.
 */

export type RequestMode = 'recurring' | 'scheduled' | 'urgent';

export interface DispatchPolicy {
  initialRadiusM: number;
  maxRadiusM: number;
  expansionFactor: number;
  /** Minimum providers we want notified before we stop expanding. */
  minCandidates: number;
  /** How long a wave waits for any quote before expanding / next wave. */
  responseSlaSec: number;
  /** How many top-ranked candidates are notified per wave (staggered dispatch). */
  waveSize: number;
  /** Default quote validity. */
  quoteValiditySec: number;
  /** Re-notify previously notified providers after this cooldown (0 = never). */
  renotifyCooldownSec: number;
}

export const DEFAULT_POLICIES: Record<RequestMode, DispatchPolicy> = {
  urgent: {
    initialRadiusM: 5_000, maxRadiusM: 20_000, expansionFactor: 1.5, minCandidates: 3,
    responseSlaSec: 90, waveSize: 5, quoteValiditySec: 45 * 60, renotifyCooldownSec: 0,
  },
  scheduled: {
    initialRadiusM: 15_000, maxRadiusM: 50_000, expansionFactor: 1.5, minCandidates: 3,
    responseSlaSec: 15 * 60, waveSize: 8, quoteValiditySec: 48 * 3600, renotifyCooldownSec: 6 * 3600,
  },
  recurring: {
    initialRadiusM: 15_000, maxRadiusM: 40_000, expansionFactor: 1.5, minCandidates: 2,
    responseSlaSec: 2 * 3600, waveSize: 5, quoteValiditySec: 72 * 3600, renotifyCooldownSec: 6 * 3600,
  },
};

/** Next search radius, or null when we are already at the max (→ expire / admin-assist). */
export function nextRadius(currentM: number, p: DispatchPolicy): number | null {
  if (currentM >= p.maxRadiusM) return null;
  return Math.min(Math.round(currentM * p.expansionFactor), p.maxRadiusM);
}

export interface RankingWeights {
  distance: number;
  rating: number;
  workload: number;
  responseSpeed: number;
  urgentReliability: number;
  conversion: number;
}

export const DEFAULT_WEIGHTS: Record<RequestMode, RankingWeights> = {
  // §G.3: urgent weights distance & response speed much higher
  urgent: { distance: 0.40, rating: 0.15, workload: 0.10, responseSpeed: 0.25, urgentReliability: 0.10, conversion: 0.00 },
  scheduled: { distance: 0.10, rating: 0.45, workload: 0.10, responseSpeed: 0.15, urgentReliability: 0.00, conversion: 0.20 },
  recurring: { distance: 0.10, rating: 0.50, workload: 0.15, responseSpeed: 0.05, urgentReliability: 0.00, conversion: 0.20 },
};

export interface Candidate {
  providerId: string;
  distanceM: number;
  ratingAvg: number | null;   // 1..5
  ratingCount: number;
  activeJobs: number;
  maxConcurrentJobs: number;
  responseSpeedAvgSec: number | null;
  urgentCompletionRate: number | null; // 0..1
  quoteConversionRate: number | null;  // 0..1, accepted quotes / submitted quotes
  noShowCount: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Bayesian-smoothed rating so a single 5★ review does not outrank 200 reviews at 4.8★.
 * prior = 4.0★ weighted as 5 reviews.
 */
export function smoothedRating(avg: number | null, count: number, prior = 4.0, priorWeight = 5): number {
  const a = avg ?? prior;
  return (a * count + prior * priorWeight) / (count + priorWeight);
}

export function scoreCandidate(c: Candidate, maxRadiusM: number, w: RankingWeights, maxResponseSec = 600): number {
  const distance = 1 - clamp01(c.distanceM / Math.max(maxRadiusM, 1));
  const rating = clamp01((smoothedRating(c.ratingAvg, c.ratingCount) - 1) / 4);
  const workload = 1 - clamp01(c.activeJobs / Math.max(c.maxConcurrentJobs, 1));
  const speed = c.responseSpeedAvgSec == null ? 0.5 : 1 - clamp01(c.responseSpeedAvgSec / maxResponseSec);
  const urgent = c.urgentCompletionRate ?? 0.5;
  const conversion = c.quoteConversionRate ?? 0.5;
  const base = w.distance * distance + w.rating * rating + w.workload * workload
    + w.responseSpeed * speed + w.urgentReliability * urgent + w.conversion * conversion;
  // No-show penalty (§K risks): each recorded no-show costs 5%, capped at 50%.
  const penalty = Math.min(0.5, c.noShowCount * 0.05);
  return Number((base * (1 - penalty)).toFixed(6));
}

export function rankCandidates(cands: Candidate[], maxRadiusM: number, w: RankingWeights): Array<Candidate & { score: number }> {
  return cands
    .map(c => ({ ...c, score: scoreCandidate(c, maxRadiusM, w) }))
    .sort((a, b) => b.score - a.score || a.distanceM - b.distanceM || a.providerId.localeCompare(b.providerId));
}

/** Choose the next wave: top-K ranked candidates not yet notified. */
export function selectWave<T extends { providerId: string }>(ranked: T[], alreadyNotified: Set<string>, waveSize: number): T[] {
  return ranked.filter(c => !alreadyNotified.has(c.providerId)).slice(0, waveSize);
}

/* ─────────────────────────── geometry helpers ─────────────────────────── */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance (used client-side / for plausibility checks; the server matches with PostGIS). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Privacy obfuscation (§G.7): snap to a ~gridM grid cell centre. Deterministic
 * (same input → same output) so repeated views cannot be averaged to recover
 * the exact point, unlike random jitter.
 */
export function approximateLocation(lat: number, lng: number, gridM = 400): { lat: number; lng: number } {
  const latStep = gridM / 111_320;
  const lngStep = gridM / (111_320 * Math.max(Math.cos(toRad(lat)), 0.01));
  const snap = (v: number, step: number) => Math.floor(v / step) * step + step / 2;
  return { lat: Number(snap(lat, latStep).toFixed(6)), lng: Number(snap(lng, lngStep).toFixed(6)) };
}

export interface LocationPing { lat: number; lng: number; at: Date; accuracyM?: number; mocked?: boolean }

/**
 * Teleportation / spoofing detection (§J): implied speed between pings above a
 * plausible ground speed (default 200 km/h) flags the ping for fraud review.
 */
export function isImplausibleJump(prev: LocationPing, next: LocationPing, maxSpeedKmh = 200): boolean {
  if (next.mocked) return true;
  const dt = (next.at.getTime() - prev.at.getTime()) / 1000;
  const d = haversineM(prev.lat, prev.lng, next.lat, next.lng);
  if (dt <= 0) return d > 50;
  const tolerance = (prev.accuracyM ?? 0) + (next.accuracyM ?? 0);
  const speedKmh = (Math.max(0, d - tolerance) / dt) * 3.6;
  return speedKmh > maxSpeedKmh;
}

/** Start/complete geofence check (§C.5 guard, §J). */
export function withinGeofence(provider: { lat: number; lng: number; accuracyM?: number }, job: { lat: number; lng: number }, radiusM = 300): boolean {
  return haversineM(provider.lat, provider.lng, job.lat, job.lng) <= radiusM + Math.min(provider.accuracyM ?? 0, 200);
}

/** ETA estimate for urgent dispatch UIs (urban average speed). */
export function etaMinutes(distanceM: number, avgSpeedKmh = 25): number {
  return Math.max(5, Math.round((distanceM / 1000 / avgSpeedKmh) * 60));
}
