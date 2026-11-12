"use strict";
/**
 * Generic, table-driven finite state machine (spec §C).
 *
 * Every entity's lifecycle is declared as an explicit transition table. The
 * backend persists each transition as an immutable row in the entity's
 * *_events table and updates the cached `status` column in the SAME
 * transaction, guarded by `WHERE status = <from>` (optimistic concurrency),
 * so two racing actors can never both apply a transition.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateMachine = exports.InvalidTransitionError = void 0;
class InvalidTransitionError extends Error {
    machine;
    from;
    trigger;
    reason;
    constructor(machine, from, trigger, reason) {
        super(`[${machine}] cannot apply '${trigger}' from '${from}': ${reason}`);
        this.machine = machine;
        this.from = from;
        this.trigger = trigger;
        this.reason = reason;
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
class StateMachine {
    name;
    states;
    terminal;
    transitions;
    index = new Map();
    constructor(name, states, terminal, transitions) {
        this.name = name;
        this.states = states;
        this.terminal = terminal;
        this.transitions = transitions;
        for (const t of transitions) {
            const froms = (Array.isArray(t.from) ? t.from : [t.from]);
            for (const f of froms) {
                if (!states.includes(f))
                    throw new Error(`[${name}] unknown from-state ${f}`);
                if (terminal.includes(f))
                    throw new Error(`[${name}] transition out of terminal state ${f}`);
                const key = `${f}::${t.trigger}`;
                if (this.index.has(key))
                    throw new Error(`[${name}] ambiguous transition ${key}`);
                this.index.set(key, t);
            }
            if (!states.includes(t.to))
                throw new Error(`[${name}] unknown to-state ${t.to}`);
        }
    }
    /** Returns the target state or throws InvalidTransitionError. */
    next(from, trigger, actor) {
        const t = this.index.get(`${from}::${trigger}`);
        if (!t)
            throw new InvalidTransitionError(this.name, from, trigger, 'no such transition');
        if (!t.actors.includes(actor)) {
            throw new InvalidTransitionError(this.name, from, trigger, `actor '${actor}' not permitted`);
        }
        return t.to;
    }
    can(from, trigger, actor) {
        const t = this.index.get(`${from}::${trigger}`);
        return !!t && (!actor || t.actors.includes(actor));
    }
    isTerminal(s) {
        return this.terminal.includes(s);
    }
    /** Triggers available from a state (for UIs to render the right buttons). */
    available(from, actor) {
        return this.transitions
            .filter(t => (Array.isArray(t.from) ? t.from : [t.from]).includes(from))
            .filter(t => !actor || t.actors.includes(actor))
            .map(t => t.trigger);
    }
    /** States from which `target` is reachable (used by tests to prove no orphan states). */
    reachableFrom(start) {
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length) {
            const s = queue.shift();
            for (const t of this.transitions) {
                const froms = (Array.isArray(t.from) ? t.from : [t.from]);
                if (froms.includes(s) && !seen.has(t.to)) {
                    seen.add(t.to);
                    queue.push(t.to);
                }
            }
        }
        return seen;
    }
}
exports.StateMachine = StateMachine;
