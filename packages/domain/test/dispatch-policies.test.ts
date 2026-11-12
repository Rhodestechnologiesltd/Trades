import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICIES, nextRadius, rankCandidates, DEFAULT_WEIGHTS, selectWave, Candidate, haversineM,
  approximateLocation, isImplausibleJump, withinGeofence,
  validateNewCounter, assertCanRespond, CounterRound, NegotiationError, currentProviderOffer,
  cancellationOutcome, canOpenDispute, reviewVisibleAt, clawbackRecoveryFor, fromMajor, money,
  occurrences, describeRule, moderateText,
} from '../src';

const base: Candidate = {
  providerId: 'x', distanceM: 1000, ratingAvg: 4.5, ratingCount: 20, activeJobs: 0, maxConcurrentJobs: 2,
  responseSpeedAvgSec: 60, urgentCompletionRate: 0.9, quoteConversionRate: 0.4, noShowCount: 0,
};

test('radius expansion ×1.5 up to max, then null', () => {
  const p = DEFAULT_POLICIES.urgent;
  assert.equal(nextRadius(5000, p), 7500);
  assert.equal(nextRadius(18000, p), 20000);
  assert.equal(nextRadius(20000, p), null);
});

test('urgent ranking favours the near provider; scheduled favours the better-rated one', () => {
  const near = { ...base, providerId: 'near', distanceM: 500, ratingAvg: 4.0, ratingCount: 30 };
  const good = { ...base, providerId: 'good', distanceM: 8000, ratingAvg: 4.95, ratingCount: 200 };
  assert.equal(rankCandidates([good, near], 15000, DEFAULT_WEIGHTS.urgent)[0].providerId, 'near');
  assert.equal(rankCandidates([near, good], 15000, DEFAULT_WEIGHTS.scheduled)[0].providerId, 'good');
});

test('no-shows and full workload push providers down', () => {
  const reliable = { ...base, providerId: 'a' };
  const flaky = { ...base, providerId: 'b', noShowCount: 4 };
  const busy = { ...base, providerId: 'c', activeJobs: 2 };
  const ranked = rankCandidates([flaky, busy, reliable], 15000, DEFAULT_WEIGHTS.scheduled).map(c => c.providerId);
  assert.equal(ranked[0], 'a');
  assert.equal(ranked[2], 'b');
});

test('waves skip already-notified providers', () => {
  const ranked = ['a', 'b', 'c', 'd'].map(providerId => ({ providerId }));
  assert.deepEqual(selectWave(ranked, new Set(['a', 'c']), 2).map(c => c.providerId), ['b', 'd']);
});

test('geometry: haversine Port Louis → Curepipe ≈ 17km; obfuscation stays within ~300m', () => {
  const d = haversineM(-20.1609, 57.5012, -20.3163, 57.5259);
  assert.ok(d > 16000 && d < 18500, `got ${d}`);
  const a = approximateLocation(-20.1609, 57.5012);
  assert.ok(haversineM(-20.1609, 57.5012, a.lat, a.lng) < 300);
  assert.deepEqual(approximateLocation(-20.1609, 57.5012), a, 'deterministic');
});

test('spoofing: 20km jump in 60s is implausible; mock flag always is', () => {
  const t = new Date('2026-01-01T10:00:00Z');
  assert.ok(isImplausibleJump({ lat: -20.16, lng: 57.50, at: t }, { lat: -20.34, lng: 57.50, at: new Date(t.getTime() + 60_000) }));
  assert.ok(!isImplausibleJump({ lat: -20.16, lng: 57.50, at: t }, { lat: -20.161, lng: 57.501, at: new Date(t.getTime() + 60_000) }));
  assert.ok(isImplausibleJump({ lat: 0, lng: 0, at: t }, { lat: 0, lng: 0, at: new Date(t.getTime() + 1000), mocked: true }));
  assert.ok(withinGeofence({ lat: -20.1609, lng: 57.5012 }, { lat: -20.1620, lng: 57.5020 }));
  assert.ok(!withinGeofence({ lat: -20.1609, lng: 57.5012 }, { lat: -20.2, lng: 57.5 }));
});

test('negotiation: alternating rounds, capped, only the other party responds', () => {
  const cfg = { maxRounds: 3 };
  assert.throws(() => validateNewCounter('provider', 900, 1000, [], cfg), NegotiationError);
  assert.equal(validateNewCounter('customer', 800, 1000, [], cfg), 1);
  const rounds: CounterRound[] = [{ roundNumber: 1, proposedBy: 'customer', amountMinor: 800, status: 'proposed' }];
  assert.throws(() => validateNewCounter('customer', 850, 1000, rounds, cfg));
  assert.throws(() => assertCanRespond('customer', rounds));
  assert.equal(assertCanRespond('provider', rounds).roundNumber, 1);
  rounds[0].status = 'countered';
  rounds.push({ roundNumber: 2, proposedBy: 'provider', amountMinor: 900, status: 'countered' });
  rounds.push({ roundNumber: 3, proposedBy: 'customer', amountMinor: 870, status: 'proposed' });
  assert.throws(() => validateNewCounter('provider', 880, 1000, rounds, cfg), /Maximum negotiation rounds/);
  assert.equal(currentProviderOffer(1000, rounds), 900);
  assert.throws(() => validateNewCounter('customer', 50, 1000, [], { maxRounds: 3, priceFloorMinor: 100 }), /below the minimum/);
});

test('cancellation policy', () => {
  const agreed = fromMajor('3000.00', 'MUR');
  const now = new Date('2026-05-01T10:00:00Z');
  const in1h = new Date('2026-05-01T11:00:00Z');
  const in5h = new Date('2026-05-01T15:00:00Z');
  assert.equal(cancellationOutcome({ bookingState: 'assigned', actor: 'customer', agreed, scheduledStart: in5h, now }).adjustedAgreed.minor, 0);
  assert.equal(cancellationOutcome({ bookingState: 'assigned', actor: 'customer', agreed, scheduledStart: in1h, now }).adjustedAgreed.minor, 30000);
  assert.equal(cancellationOutcome({ bookingState: 'assigned', actor: 'customer', agreed: fromMajor('500.00', 'MUR'), scheduledStart: in1h, now }).adjustedAgreed.minor, 20000);
  const prov = cancellationOutcome({ bookingState: 'assigned', actor: 'provider', agreed, scheduledStart: in1h, now });
  assert.equal(prov.adjustedAgreed.minor, 0);
  assert.ok(prov.providerPenalty);
});

test('dispute window and double-blind review release', () => {
  const done = new Date('2026-05-01T10:00:00Z');
  assert.ok(canOpenDispute('completed_by_provider', done, new Date('2026-05-03T10:00:00Z')));
  assert.ok(!canOpenDispute('payout_released', done, new Date('2026-05-05T10:00:01Z')));
  assert.ok(canOpenDispute('assigned', null, new Date()));
  const a = new Date('2026-05-01T12:00:00Z');
  const b = new Date('2026-05-02T12:00:00Z');
  assert.deepEqual(reviewVisibleAt({ submittedAt: a, counterpartReviewedAt: b, jobCompletedAt: done }), b);
  assert.deepEqual(reviewVisibleAt({ submittedAt: a, counterpartReviewedAt: null, jobCompletedAt: done }), new Date('2026-05-15T10:00:00Z'));
});

test('clawback recovery capped at 50% of a payout', () => {
  assert.equal(clawbackRecoveryFor(money(85000, 'MUR'), 100000).minor, 42500);
  assert.equal(clawbackRecoveryFor(money(85000, 'MUR'), 1000).minor, 1000);
});

test('recurrence: weekly Tue/Thu 15:00 in Mauritius (UTC+4)', () => {
  const start = new Date('2026-10-05T00:00:00Z'); // Monday
  const occ = occurrences('FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=15;BYMINUTE=0', start, 'Indian/Mauritius', { limit: 4 });
  assert.deepEqual(occ.map(d => d.toISOString()), [
    '2026-10-06T11:00:00.000Z', '2026-10-08T11:00:00.000Z', '2026-10-13T11:00:00.000Z', '2026-10-15T11:00:00.000Z',
  ]);
  const biweekly = occurrences('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9', start, 'Indian/Mauritius', { limit: 3 });
  assert.deepEqual(biweekly.map(d => d.toISOString().slice(0, 10)), ['2026-10-05', '2026-10-19', '2026-11-02']);
  assert.equal(occurrences('FREQ=DAILY;COUNT=3;BYHOUR=8', start, 'UTC').length, 3);
  assert.equal(describeRule('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=15'), 'Every week on Mon, Wed at 15:00');
});

test('moderation redacts contact details and flags profanity', () => {
  const r = moderateText('Great job! Call me on +230 5712 3456 or mail joe@example.com');
  assert.ok(!r.text.includes('5712'));
  assert.ok(!r.text.includes('joe@'));
  assert.deepEqual(r.reasons, ['email', 'phone']);
  assert.ok(moderateText('total shit work').flagged);
  assert.ok(!moderateText('Arrived on time, 5 stars').redacted);
});
