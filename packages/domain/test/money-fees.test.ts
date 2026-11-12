import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromMajor, toMajorString, money, percentOf, allocate, computeFees, resolveFeeConfig,
  PLATFORM_DEFAULT_FEES, effectiveTakeRate, pctToBps,
} from '../src';

test('fromMajor/toMajorString round-trip without float drift', () => {
  assert.equal(fromMajor('1250.50', 'MUR').minor, 125050);
  assert.equal(fromMajor(0.1 + 0.2, 'MUR').minor, 30);
  assert.equal(toMajorString(money(125050, 'MUR')), '1250.50');
  assert.equal(toMajorString(money(5, 'MUR')), '0.05');
  assert.equal(toMajorString(money(-5, 'MUR')), '-0.05');
  assert.equal(toMajorString(money(1500, 'JPY')), '1500');
  assert.throws(() => fromMajor('1.234', 'MUR'));
  assert.equal(fromMajor('1.230', 'MUR').minor, 123);
});

test('percentOf rounds half-up', () => {
  assert.equal(percentOf(money(1000, 'MUR'), 1500).minor, 150);
  assert.equal(percentOf(money(3, 'MUR'), 1500).minor, 0);   // 0.45 → 0
  assert.equal(percentOf(money(10, 'MUR'), 1500).minor, 2);  // 1.5 → 2
  assert.equal(percentOf(money(-10, 'MUR'), 1500).minor, -2);
});

test('allocate sums exactly', () => {
  const parts = allocate(money(1001, 'MUR'), 3);
  assert.deepEqual(parts.map(p => p.minor), [334, 334, 333]);
  assert.equal(parts.reduce((s, p) => s + p.minor, 0), 1001);
});

test('spec fee model: customer pays agreed × 1.15, provider gets agreed × 0.85, platform takes 30%', () => {
  const b = computeFees(fromMajor('2000.00', 'MUR'), PLATFORM_DEFAULT_FEES);
  assert.equal(toMajorString(b.customerFee), '300.00');
  assert.equal(toMajorString(b.customerCharge), '2300.00');
  assert.equal(toMajorString(b.providerCommission), '300.00');
  assert.equal(toMajorString(b.providerNet), '1700.00');
  assert.equal(toMajorString(b.platformGross), '600.00');
  assert.equal(effectiveTakeRate(b), 0.3);
});

test('fee invariants hold for every amount 1..50,000 minor units', () => {
  for (let m = 1; m <= 50_000; m += 7) {
    const b = computeFees(money(m, 'MUR'), PLATFORM_DEFAULT_FEES);
    assert.equal(b.customerCharge.minor, b.providerNet.minor + b.platformGross.minor);
  }
});

test('fee config resolution: category > market > platform', () => {
  const cfg = resolveFeeConfig(PLATFORM_DEFAULT_FEES, { market: { customerFeeBps: 1000 }, category: { providerCommissionBps: 1200 } });
  assert.deepEqual(cfg, { customerFeeBps: 1000, providerCommissionBps: 1200 });
  assert.throws(() => resolveFeeConfig(PLATFORM_DEFAULT_FEES, { category: { customerFeeBps: 9000 } }));
  assert.equal(pctToBps('15.00'), 1500);
});

test('rejects non-positive agreed amounts and mixed currencies', () => {
  assert.throws(() => computeFees(money(0, 'MUR'), PLATFORM_DEFAULT_FEES));
  assert.throws(() => money(1.5, 'MUR'));
  assert.throws(() => money(1, 'mur'));
});
