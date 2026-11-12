import { Money, add, money, percentOf, sub } from './money';

/**
 * Fee model (spec §0 and §F.2):
 *   customer is charged   agreed + customerFee        (fee is ADDITIVE, on top)
 *   provider receives     agreed - commission         (commission is DEDUCTIVE)
 *   platform gross take = customerFee + commission    (30% of agreed at 15%/15%)
 *
 * Both rates are configuration, resolved most-specific-first:
 *   category override  >  market override  >  platform default
 * The resolved rates are FROZEN onto the booking at creation (platform_fees /
 * platform_commissions rows) and never recalculated afterwards.
 */

export interface FeeConfig {
  /** Fee added to the customer's charge, in basis points. Default 1500 (15%). */
  customerFeeBps: number;
  /** Commission deducted from the provider's payout, in basis points. Default 1500 (15%). */
  providerCommissionBps: number;
}

export const PLATFORM_DEFAULT_FEES: FeeConfig = Object.freeze({
  customerFeeBps: 1500,
  providerCommissionBps: 1500,
});

export interface FeeOverrides {
  market?: Partial<FeeConfig> | null;
  category?: Partial<FeeConfig> | null;
}

export function resolveFeeConfig(platform: FeeConfig, overrides: FeeOverrides = {}): FeeConfig {
  const pick = (k: keyof FeeConfig): number =>
    overrides.category?.[k] ?? overrides.market?.[k] ?? platform[k];
  const cfg = { customerFeeBps: pick('customerFeeBps'), providerCommissionBps: pick('providerCommissionBps') };
  for (const [k, v] of Object.entries(cfg)) {
    if (!Number.isInteger(v) || v < 0 || v > 5000) {
      // Guard rail: no fee/commission over 50% can ever be configured.
      throw new Error(`Fee config ${k}=${v} bps is outside the allowed range 0..5000`);
    }
  }
  return cfg;
}

export interface FeeBreakdown {
  agreed: Money;
  customerFeeBps: number;
  customerFee: Money;
  /** What MIPS charges the customer's card. */
  customerCharge: Money;
  providerCommissionBps: number;
  providerCommission: Money;
  /** What the provider is paid out at T+48h. */
  providerNet: Money;
  /** customerFee + providerCommission. */
  platformGross: Money;
}

export function computeFees(agreed: Money, cfg: FeeConfig): FeeBreakdown {
  if (agreed.minor <= 0) throw new Error('Agreed amount must be positive');
  const customerFee = percentOf(agreed, cfg.customerFeeBps);
  const providerCommission = percentOf(agreed, cfg.providerCommissionBps);
  const breakdown: FeeBreakdown = {
    agreed,
    customerFeeBps: cfg.customerFeeBps,
    customerFee,
    customerCharge: add(agreed, customerFee),
    providerCommissionBps: cfg.providerCommissionBps,
    providerCommission,
    providerNet: sub(agreed, providerCommission),
    platformGross: add(customerFee, providerCommission),
  };
  assertFeeInvariants(breakdown);
  return breakdown;
}

/** Invariants that must hold for every booking; violated => refuse to create the payment. */
export function assertFeeInvariants(b: FeeBreakdown): void {
  const c = b.agreed.currency;
  const check = (cond: boolean, msg: string) => { if (!cond) throw new Error(`Fee invariant violated: ${msg}`); };
  check(b.customerCharge.minor === b.agreed.minor + b.customerFee.minor, 'charge = agreed + fee');
  check(b.providerNet.minor === b.agreed.minor - b.providerCommission.minor, 'net = agreed - commission');
  // Money conservation: everything charged is either provider's or platform's.
  check(b.customerCharge.minor === b.providerNet.minor + b.platformGross.minor, 'charge = net + platform gross');
  check(b.providerNet.minor >= 0, 'net payout non-negative');
  check([b.customerFee, b.customerCharge, b.providerCommission, b.providerNet, b.platformGross].every(m => m.currency === c), 'single currency');
}

/** Effective take rate as a fraction of agreed (for dashboards / alerts). */
export function effectiveTakeRate(b: FeeBreakdown): number {
  return b.platformGross.minor / b.agreed.minor;
}

/** Rebuild a breakdown from frozen persisted values (used by ledger/payout code). */
export function breakdownFromFrozen(agreedMinor: number, currency: string, customerFeeBps: number, providerCommissionBps: number): FeeBreakdown {
  return computeFees(money(agreedMinor, currency), { customerFeeBps, providerCommissionBps });
}
