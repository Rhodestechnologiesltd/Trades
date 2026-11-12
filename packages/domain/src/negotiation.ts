/**
 * Quote & counter-offer rules (spec §A.4, §A.5).
 *
 * Each round is an immutable counter_offers row. Round 1 is the customer's first
 * counter against the provider's quote; parties alternate. Once round_number
 * reaches maxRounds, the receiving party may only accept or reject — and if the
 * provider rejects a customer's final counter, the provider's last offer stands
 * as final-offer-only.
 */

export type Party = 'customer' | 'provider';

export interface NegotiationConfig {
  maxRounds: number;          // default 3 (spec) — MVP may set 1–2
  priceFloorMinor?: number | null;   // admin-set hard floor for regulated trades
  priceCeilingMinor?: number | null; // admin-set hard ceiling
}

export interface CounterRound {
  roundNumber: number;
  proposedBy: Party;
  amountMinor: number;
  status: 'proposed' | 'accepted' | 'rejected' | 'expired' | 'countered';
}

export class NegotiationError extends Error {}

export function assertPriceInBand(amountMinor: number, cfg: NegotiationConfig): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new NegotiationError('Amount must be a positive amount');
  if (cfg.priceFloorMinor != null && amountMinor < cfg.priceFloorMinor) throw new NegotiationError('Amount is below the minimum price for this service');
  if (cfg.priceCeilingMinor != null && amountMinor > cfg.priceCeilingMinor) throw new NegotiationError('Amount is above the maximum price for this service');
}

/** The open round (if any) is the latest one still 'proposed'. */
export function openRound(rounds: CounterRound[]): CounterRound | undefined {
  const last = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber).at(-1);
  return last && last.status === 'proposed' ? last : undefined;
}

/** The amount currently on the table (last provider offer if no accepted counter). */
export function currentProviderOffer(quoteAmountMinor: number, rounds: CounterRound[]): number {
  const providerRounds = rounds.filter(r => r.proposedBy === 'provider').sort((a, b) => a.roundNumber - b.roundNumber);
  return providerRounds.at(-1)?.amountMinor ?? quoteAmountMinor;
}

/** Validate a new counter by `by` and return its round number. */
export function validateNewCounter(
  by: Party,
  amountMinor: number,
  quoteAmountMinor: number,
  rounds: CounterRound[],
  cfg: NegotiationConfig,
): number {
  assertPriceInBand(amountMinor, cfg);
  const sorted = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber);
  const last = sorted.at(-1);
  if (!last) {
    if (by !== 'customer') throw new NegotiationError('The customer opens negotiation by countering the quote');
    if (cfg.maxRounds < 1) throw new NegotiationError('Counter-offers are disabled for this service');
    if (amountMinor === quoteAmountMinor) throw new NegotiationError('Counter amount must differ from the quote');
    return 1;
  }
  if (last.status !== 'proposed') throw new NegotiationError('There is no open offer to counter');
  if (last.proposedBy === by) throw new NegotiationError('Wait for the other party to respond');
  if (last.roundNumber >= cfg.maxRounds) throw new NegotiationError('Maximum negotiation rounds reached — accept or decline the final offer');
  if (amountMinor === last.amountMinor) throw new NegotiationError('Counter amount must differ — use accept instead');
  return last.roundNumber + 1;
}

/** Only the party that did NOT propose the open round can accept/reject it. */
export function assertCanRespond(by: Party, rounds: CounterRound[]): CounterRound {
  const open = openRound(rounds);
  if (!open) throw new NegotiationError('There is no open offer');
  if (open.proposedBy === by) throw new NegotiationError('You cannot respond to your own offer');
  return open;
}

export function roundsRemaining(rounds: CounterRound[], cfg: NegotiationConfig): number {
  const last = Math.max(0, ...rounds.map(r => r.roundNumber));
  return Math.max(0, cfg.maxRounds - last);
}
