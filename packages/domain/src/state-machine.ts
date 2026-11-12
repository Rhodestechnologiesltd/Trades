/**
 * Generic, table-driven finite state machine (spec §C).
 *
 * Every entity's lifecycle is declared as an explicit transition table. The
 * backend persists each transition as an immutable row in the entity's
 * *_events table and updates the cached `status` column in the SAME
 * transaction, guarded by `WHERE status = <from>` (optimistic concurrency),
 * so two racing actors can never both apply a transition.
 */

export type ActorType = 'customer' | 'provider' | 'admin' | 'support' | 'finance' | 'system';

export interface Transition<S extends string, T extends string> {
  from: S | readonly S[];
  to: S;
  trigger: T;
  /** Which principal types may fire this trigger. */
  actors: readonly ActorType[];
  description?: string;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly trigger: string,
    public readonly reason: string,
  ) {
    super(`[${machine}] cannot apply '${trigger}' from '${from}': ${reason}`);
  }
}

export class StateMachine<S extends string, T extends string> {
  private readonly index = new Map<string, Transition<S, T>>();

  constructor(
    public readonly name: string,
    public readonly states: readonly S[],
    public readonly terminal: readonly S[],
    public readonly transitions: readonly Transition<S, T>[],
  ) {
    for (const t of transitions) {
      const froms = (Array.isArray(t.from) ? t.from : [t.from]) as S[];
      for (const f of froms) {
        if (!states.includes(f)) throw new Error(`[${name}] unknown from-state ${f}`);
        if (terminal.includes(f)) throw new Error(`[${name}] transition out of terminal state ${f}`);
        const key = `${f}::${t.trigger}`;
        if (this.index.has(key)) throw new Error(`[${name}] ambiguous transition ${key}`);
        this.index.set(key, t);
      }
      if (!states.includes(t.to)) throw new Error(`[${name}] unknown to-state ${t.to}`);
    }
  }

  /** Returns the target state or throws InvalidTransitionError. */
  next(from: S, trigger: T, actor: ActorType): S {
    const t = this.index.get(`${from}::${trigger}`);
    if (!t) throw new InvalidTransitionError(this.name, from, trigger, 'no such transition');
    if (!t.actors.includes(actor)) {
      throw new InvalidTransitionError(this.name, from, trigger, `actor '${actor}' not permitted`);
    }
    return t.to;
  }

  can(from: S, trigger: T, actor?: ActorType): boolean {
    const t = this.index.get(`${from}::${trigger}`);
    return !!t && (!actor || t.actors.includes(actor));
  }

  isTerminal(s: S): boolean {
    return this.terminal.includes(s);
  }

  /** Triggers available from a state (for UIs to render the right buttons). */
  available(from: S, actor?: ActorType): T[] {
    return this.transitions
      .filter(t => (Array.isArray(t.from) ? t.from : [t.from]).includes(from))
      .filter(t => !actor || t.actors.includes(actor))
      .map(t => t.trigger);
  }

  /** States from which `target` is reachable (used by tests to prove no orphan states). */
  reachableFrom(start: S): Set<S> {
    const seen = new Set<S>([start]);
    const queue: S[] = [start];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of this.transitions) {
        const froms = (Array.isArray(t.from) ? t.from : [t.from]) as S[];
        if (froms.includes(s) && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
      }
    }
    return seen;
  }
}
