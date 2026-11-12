"use strict";
/**
 * Geolocation & dispatch rules (spec §G). Hard filters (zone containment,
 * category, verification, availability, workload) run in SQL; this module owns
 * the policy numbers and the ranking/wave logic so they are unit-testable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WEIGHTS = exports.DEFAULT_POLICIES = void 0;
exports.nextRadius = nextRadius;
exports.smoothedRating = smoothedRating;
exports.scoreCandidate = scoreCandidate;
exports.rankCandidates = rankCandidates;
exports.selectWave = selectWave;
exports.haversineM = haversineM;
exports.isValidCoordinate = isValidCoordinate;
exports.approximateLocation = approximateLocation;
exports.isImplausibleJump = isImplausibleJump;
exports.withinGeofence = withinGeofence;
exports.etaMinutes = etaMinutes;
exports.DEFAULT_POLICIES = {
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
function nextRadius(currentM, p) {
    if (currentM >= p.maxRadiusM)
        return null;
    return Math.min(Math.round(currentM * p.expansionFactor), p.maxRadiusM);
}
exports.DEFAULT_WEIGHTS = {
    // §G.3: urgent weights distance & response speed much higher
    urgent: { distance: 0.40, rating: 0.15, workload: 0.10, responseSpeed: 0.25, urgentReliability: 0.10, conversion: 0.00 },
    scheduled: { distance: 0.10, rating: 0.45, workload: 0.10, responseSpeed: 0.15, urgentReliability: 0.00, conversion: 0.20 },
    recurring: { distance: 0.10, rating: 0.50, workload: 0.15, responseSpeed: 0.05, urgentReliability: 0.00, conversion: 0.20 },
};
const clamp01 = (n) => Math.max(0, Math.min(1, n));
/**
 * Bayesian-smoothed rating so a single 5★ review does not outrank 200 reviews at 4.8★.
 * prior = 4.0★ weighted as 5 reviews.
 */
function smoothedRating(avg, count, prior = 4.0, priorWeight = 5) {
    const a = avg ?? prior;
    return (a * count + prior * priorWeight) / (count + priorWeight);
}
function scoreCandidate(c, maxRadiusM, w, maxResponseSec = 600) {
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
function rankCandidates(cands, maxRadiusM, w) {
    return cands
        .map(c => ({ ...c, score: scoreCandidate(c, maxRadiusM, w) }))
        .sort((a, b) => b.score - a.score || a.distanceM - b.distanceM || a.providerId.localeCompare(b.providerId));
}
/** Choose the next wave: top-K ranked candidates not yet notified. */
function selectWave(ranked, alreadyNotified, waveSize) {
    return ranked.filter(c => !alreadyNotified.has(c.providerId)).slice(0, waveSize);
}
/* ─────────────────────────── geometry helpers ─────────────────────────── */
const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d) => (d * Math.PI) / 180;
/** Great-circle distance (used client-side / for plausibility checks; the server matches with PostGIS). */
function haversineM(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
function isValidCoordinate(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
/**
 * Privacy obfuscation (§G.7): snap to a ~gridM grid cell centre. Deterministic
 * (same input → same output) so repeated views cannot be averaged to recover
 * the exact point, unlike random jitter.
 */
function approximateLocation(lat, lng, gridM = 400) {
    const latStep = gridM / 111_320;
    const lngStep = gridM / (111_320 * Math.max(Math.cos(toRad(lat)), 0.01));
    const snap = (v, step) => Math.floor(v / step) * step + step / 2;
    return { lat: Number(snap(lat, latStep).toFixed(6)), lng: Number(snap(lng, lngStep).toFixed(6)) };
}
/**
 * Teleportation / spoofing detection (§J): implied speed between pings above a
 * plausible ground speed (default 200 km/h) flags the ping for fraud review.
 */
function isImplausibleJump(prev, next, maxSpeedKmh = 200) {
    if (next.mocked)
        return true;
    const dt = (next.at.getTime() - prev.at.getTime()) / 1000;
    const d = haversineM(prev.lat, prev.lng, next.lat, next.lng);
    if (dt <= 0)
        return d > 50;
    const tolerance = (prev.accuracyM ?? 0) + (next.accuracyM ?? 0);
    const speedKmh = (Math.max(0, d - tolerance) / dt) * 3.6;
    return speedKmh > maxSpeedKmh;
}
/** Start/complete geofence check (§C.5 guard, §J). */
function withinGeofence(provider, job, radiusM = 300) {
    return haversineM(provider.lat, provider.lng, job.lat, job.lng) <= radiusM + Math.min(provider.accuracyM ?? 0, 200);
}
/** ETA estimate for urgent dispatch UIs (urban average speed). */
function etaMinutes(distanceM, avgSpeedKmh = 25) {
    return Math.max(5, Math.round((distanceM / 1000 / avgSpeedKmh) * 60));
}
