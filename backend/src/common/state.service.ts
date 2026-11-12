import { Injectable } from '@nestjs/common';
import { StateMachine } from '@trades/domain';
import { Actor } from './auth';
import { DbService, Queryable } from './db.service';
import { ConflictError, NotFoundError } from './errors';

const TABLES: Record<string, string> = {
  service_request: 'service_requests',
  provider_dispatch: 'provider_dispatches',
  quote: 'quotes',
  counter_offer: 'counter_offers',
  booking: 'bookings',
  payment: 'payments',
  payout: 'payout_records',
  dispute: 'disputes',
  recurring_agreement: 'recurring_agreements',
};

export interface TransitionResult<S> { from: S; to: S; row: any }

/**
 * Applies a state-machine transition atomically (spec §C):
 *  1. lock the row (SELECT … FOR UPDATE) inside the caller's transaction
 *  2. validate trigger + actor against the domain transition table
 *  3. update status (+ extra columns) and append an immutable state_events row
 */
@Injectable()
export class StateService {
  constructor(private readonly db: DbService) {}

  async transition<S extends string, T extends string>(
    q: Queryable,
    machine: StateMachine<S, T>,
    id: string,
    trigger: T,
    actor: Actor,
    opts: { set?: Record<string, unknown>; metadata?: Record<string, unknown>; expectFrom?: S[] } = {},
  ): Promise<TransitionResult<S>> {
    const table = TABLES[machine.name];
    if (!table) throw new Error(`No table mapped for machine ${machine.name}`);
    const current = await this.db.one<{ status: S }>(`SELECT status FROM ${table} WHERE id = $1 FOR UPDATE`, [id], q);
    if (!current) throw new NotFoundError(`${machine.name.replace('_', ' ')} not found`);
    if (opts.expectFrom && !opts.expectFrom.includes(current.status)) {
      throw new ConflictError(`Expected ${machine.name} to be ${opts.expectFrom.join('/')} but it is ${current.status}`, 'invalid_state');
    }
    const to = machine.next(current.status, trigger, actor.type);

    const sets: string[] = ['status = $2'];
    const params: unknown[] = [id, to];
    for (const [col, val] of Object.entries(opts.set ?? {})) {
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) throw new Error(`bad column ${col}`);
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    if (table === 'bookings') sets.push('version = version + 1');
    const row = await this.db.one(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params, q);

    await q.query(
      `INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, actor_user_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [machine.name, id, current.status, to, trigger, actor.type, actor.userId, JSON.stringify(opts.metadata ?? {})],
    );
    return { from: current.status, to, row };
  }

  /** Records the initial state of a newly created entity in the event history. */
  async created(q: Queryable, entity: string, id: string, state: string, actor: Actor, metadata: Record<string, unknown> = {}) {
    await q.query(
      `INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, actor_user_id, metadata)
       VALUES ($1,$2,NULL,$3,'create',$4,$5,$6)`,
      [entity, id, state, actor.type, actor.userId, JSON.stringify(metadata)],
    );
  }

  async history(entity: string, id: string) {
    return this.db.many(
      `SELECT from_state, to_state, trigger, actor_type, actor_user_id, metadata, occurred_at
         FROM state_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`, [entity, id]);
  }
}
