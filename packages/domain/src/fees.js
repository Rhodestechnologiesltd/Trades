"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_DEFAULT_FEES = void 0;
exports.resolveFeeConfig = resolveFeeConfig;
exports.computeFees = computeFees;
exports.assertFeeInvariants = assertFeeInvariants;
exports.effectiveTakeRate = effectiveTakeRate;
exports.breakdownFromFrozen = breakdownFromFrozen;
const money_1 = require("./money");
exports.PLATFORM_DEFAULT_FEES = Object.freeze({
    customerFeeBps: 1500,
    providerCommissionBps: 1500,
});
function resolveFeeConfig(platform, overrides = {}) {
    const pick = (k) => overrides.category?.[k] ?? overrides.market?.[k] ?? platform[k];
    const cfg = { customerFeeBps: pick('customerFeeBps'), providerCommissionBps: pick('providerCommissionBps') };
    for (const [k, v] of Object.entries(cfg)) {
        if (!Number.isInteger(v) || v < 0 || v > 5000) {
            // Guard rail: no fee/commission over 50% can ever be configured.
            throw new Error(`Fee config ${k}=${v} bps is outside the allowed range 0..5000`);
        }
    }
    return cfg;
}
function computeFees(agreed, cfg) {
    if (agreed.minor <= 0)
        throw new Error('Agreed amount must be positive');
    const customerFee = (0, money_1.percentOf)(agreed, cfg.customerFeeBps);
    const providerCommission = (0, money_1.percentOf)(agreed, cfg.providerCommissionBps);
    const breakdown = {
        agreed,
        customerFeeBps: cfg.customerFeeBps,
        customerFee,
        customerCharge: (0, money_1.add)(agreed, customerFee),
        providerCommissionBps: cfg.providerCommissionBps,
        providerCommission,
        providerNet: (0, money_1.sub)(agreed, providerCommission),
        platformGross: (0, money_1.add)(customerFee, providerCommission),
    };
    assertFeeInvariants(breakdown);
    return breakdown;
}
/** Invariants that must hold for every booking; violated => refuse to create the payment. */
function assertFeeInvariants(b) {
    const c = b.agreed.currency;
    const check = (cond, msg) => { if (!cond)
        throw new Error(`Fee invariant violated: ${msg}`); };
    check(b.customerCharge.minor === b.agreed.minor + b.customerFee.minor, 'charge = agreed + fee');
    check(b.providerNet.minor === b.agreed.minor - b.providerCommission.minor, 'net = agreed - commission');
    // Money conservation: everything charged is either provider's or platform's.
    check(b.customerCharge.minor === b.providerNet.minor + b.platformGross.minor, 'charge = net + platform gross');
    check(b.providerNet.minor >= 0, 'net payout non-negative');
    check([b.customerFee, b.customerCharge, b.providerCommission, b.providerNet, b.platformGross].every(m => m.currency === c), 'single currency');
}
/** Effective take rate as a fraction of agreed (for dashboards / alerts). */
function effectiveTakeRate(b) {
    return b.platformGross.minor / b.agreed.minor;
}
/** Rebuild a breakdown from frozen persisted values (used by ledger/payout code). */
function breakdownFromFrozen(agreedMinor, currency, customerFeeBps, providerCommissionBps) {
    return computeFees((0, money_1.money)(agreedMinor, currency), { customerFeeBps, providerCommissionBps });
}
