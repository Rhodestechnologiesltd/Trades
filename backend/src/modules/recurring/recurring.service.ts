import { Injectable, Logger } from '@nestjs/common';
import { RecurringMachine, describeRule, occurrences, parseRule } from '@trades/domain';
import { Actor, SYSTEM_ACTOR } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ForbiddenError, ValidationError } from '../../common/errors';
import { m } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { StateService } from '../../common/state.service';
import { RequestsService } from '../requests/requests.service';

/**
 * Long-term / recurring agreements (§A.3, §G.5). Each occurrence is generated N hours
 * ahead as its own service request and goes through quote → payment → completion
 * independently. With a preferred provider it is offered to them first (short window,
 * at the pre-agreed rate); full geo-dispatch is the fallback.
 */
@Injectable()
export class RecurringService {
  private readonly log = new Logger('Recurring');
  constructor(private readonly db: DbService, private readonly state: StateService, private readonly requests: RequestsService, private readonly outbox: OutboxService) {}

  async create(a: Actor, d: { categoryId: string; addressId: string; cadenceRule: string; startsOn: string; durationMin?: number; description: string; preferredProviderId?: string; agreedRate?: string; leadTimeHours?: number }) {
    parseRule(d.cadenceRule);
    const addr = await this.db.one(`SELECT id FROM addresses WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`, [d.addressId, a.userId]);
    if (!addr) throw new ValidationError('Address not found');
    const u = await this.db.oneOrFail(`SELECT u.market_id, mk.currency_code, mk.timezone FROM users u JOIN markets mk ON mk.id = u.market_id WHERE u.id = $1`, [a.userId]);
    const first = occurrences(d.cadenceRule, new Date(d.startsOn), u.timezone, { limit: 1 });
    if (!first.length) throw new ValidationError('This schedule produces no upcoming visits');
    if (d.agreedRate) m(d.agreedRate, u.currency_code);
    return this.db.tx(async c => {
      const row = await this.db.one(
        `INSERT INTO recurring_agreements (customer_id, category_id, market_id, address_id, preferred_provider_id, cadence_rule, starts_on, duration_min, description, agreed_rate, currency_code, lead_time_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [a.userId, d.categoryId, u.market_id, d.addressId, d.preferredProviderId ?? null, d.cadenceRule, d.startsOn, d.durationMin ?? 120, d.description,
         d.agreedRate ?? null, u.currency_code, d.leadTimeHours ?? 48], c);
      await this.state.created(c, 'recurring_agreement', row!.id, 'active', a);
      return { ...row, description_human: describeRule(d.cadenceRule), nextVisits: occurrences(d.cadenceRule, new Date(d.startsOn), u.timezone, { limit: 5 }) };
    });
  }

  async list(a: Actor) {
    const rows = await this.db.many(
      `SELECT ra.*, c.name AS category_name, COALESCE(p.business_name, pu.full_name) AS provider_name, mk.timezone
         FROM recurring_agreements ra JOIN service_categories c ON c.id = ra.category_id JOIN markets mk ON mk.id = ra.market_id
         LEFT JOIN providers p ON p.id = ra.preferred_provider_id LEFT JOIN users pu ON pu.id = ra.preferred_provider_id
        WHERE ra.customer_id = $1 OR ra.preferred_provider_id = $1 ORDER BY ra.created_at DESC`, [a.userId]);
    return rows.map(r => ({ ...r, schedule: describeRule(r.cadence_rule), nextVisits: r.status === 'active' ? occurrences(r.cadence_rule, new Date(r.starts_on), r.timezone, { after: new Date(), limit: 3 }) : [] }));
  }

  async setStatus(a: Actor, id: string, trigger: 'pause' | 'resume' | 'cancel') {
    return this.db.tx(async c => {
      const r = await this.db.oneOrFail(`SELECT * FROM recurring_agreements WHERE id = $1 FOR UPDATE`, [id], c, 'Agreement');
      if (r.customer_id !== a.userId && !(trigger === 'cancel' && r.preferred_provider_id === a.userId) && a.type !== 'admin') throw new ForbiddenError();
      return (await this.state.transition(c, RecurringMachine, id, trigger, a)).row;
    });
  }

  /** Scheduler: generate upcoming occurrences within each agreement's lead time. */
  async generateDue(): Promise<number> {
    const agreements = await this.db.many(
      `SELECT ra.*, mk.timezone FROM recurring_agreements ra JOIN markets mk ON mk.id = ra.market_id WHERE ra.status = 'active'`);
    let created = 0;
    for (const ag of agreements) {
      const horizon = new Date(Date.now() + ag.lead_time_hours * 3600_000);
      const after = ag.last_generated_for ? new Date(ag.last_generated_for) : new Date(Math.max(Date.now(), new Date(ag.starts_on).getTime()) - 1);
      const due = occurrences(ag.cadence_rule, new Date(ag.starts_on), ag.timezone, { after, horizon, limit: 10 })
        .filter(o => o.getTime() > Date.now() + 60 * 60_000);
      for (const occ of due) {
        try {
          await this.db.tx(async c => {
            const req = await this.requests.create({ userId: ag.customer_id, type: 'system' }, {
              categoryId: ag.category_id, mode: 'recurring', description: ag.description, scheduledFor: occ.toISOString(),
              scheduledWindowMin: ag.duration_min, addressId: ag.address_id, recurringAgreementId: ag.id, occurrenceAt: occ.toISOString(), skipDispatch: !!ag.preferred_provider_id,
            }, c);
            await c.query(`UPDATE recurring_agreements SET last_generated_for = $2 WHERE id = $1`, [ag.id, occ]);
            if (ag.preferred_provider_id) {
              // Offer to the preferred provider first; the generic sweep falls back to geo-dispatch after the window.
              const offerWindow = new Date(Date.now() + Math.min(12 * 3600_000, (occ.getTime() - Date.now()) / 3));
              await c.query(`UPDATE service_requests SET status = 'dispatched', next_dispatch_check_at = $2 WHERE id = $1`, [req.id, offerWindow]);
              await c.query(`INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, metadata) VALUES ('service_request',$1,'requested','dispatched','preferred_offer','system',$2)`,
                [req.id, JSON.stringify({ providerId: ag.preferred_provider_id })]);
              const d = await this.db.one(
                `INSERT INTO provider_dispatches (service_request_id, provider_id, status, wave, distance_m, notified_at, response_deadline)
                 VALUES ($1,$2,'notified',0,0,now(),$3) RETURNING id`, [req.id, ag.preferred_provider_id, offerWindow], c);
              await this.state.created(c, 'provider_dispatch', d!.id, 'notified', SYSTEM_ACTOR, { preferred: true });
              const cat = await this.db.one(`SELECT name FROM service_categories WHERE id = $1`, [ag.category_id], c);
              await this.outbox.emit(c, Events.ProviderNotified, 'service_request', req.id, {
                requestId: req.id, providerId: ag.preferred_provider_id, categoryName: cat?.name, area: 'Your regular customer', distanceKm: 0,
                recurring: true, agreedRate: ag.agreed_rate, currency: ag.currency_code,
              }, ag.market_id);
            }
            created++;
          });
        } catch (e: any) {
          if (e?.code !== '23505') this.log.warn(`agreement ${ag.id} occurrence ${occ.toISOString()}: ${e.message}`);
        }
      }
    }
    return created;
  }
}
