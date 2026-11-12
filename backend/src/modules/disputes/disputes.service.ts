import { Injectable, Logger } from '@nestjs/common';
import {
  BookingMachine, DISPUTE_ROUTING, DISPUTE_SLA_HOURS, DisputeMachine, DisputeReason, DisputeResolution, breakdownFromFrozen, canOpenDispute,
  computeSettlement, money,
} from '@trades/domain';
import { Actor, SYSTEM_ACTOR, isStaff } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { m, n } from '../../common/money';
import { Events, OutboxService } from '../../common/outbox.service';
import { PlatformConfigService } from '../../common/platform-config.service';
import { StateService } from '../../common/state.service';
import { MediaService } from '../media/media.service';
import { PaymentsService } from '../payments/payments.service';
import { PayoutsService } from '../payouts/payouts.service';

/** Reason codes support agents may resolve on their own (§I "low severity"). */
const SUPPORT_RESOLVABLE: DisputeReason[] = ['no_show', 'incomplete_work', 'other'];

@Injectable()
export class DisputesService {
  private readonly log = new Logger('Disputes');

  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly cfg: PlatformConfigService,
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly media: MediaService,
  ) {}

  /** Either party can dispute within the window; this freezes the payout immediately (§A.10). */
  async open(a: Actor, d: { bookingId: string; reasonCode: DisputeReason; description: string; evidenceKeys?: string[] }) {
    return this.db.tx(async c => {
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [d.bookingId], c, 'Booking');
      const role = b.customer_id === a.userId ? 'customer' : b.provider_id === a.userId ? 'provider' : null;
      if (!role && !isStaff(a)) throw new ForbiddenError();
      const timing = await this.cfg.timing();
      if (!isStaff(a) && !canOpenDispute(b.status, b.job_completed_at ? new Date(b.job_completed_at) : null, new Date(), timing)) {
        throw new ConflictError('The dispute window for this booking has closed', 'dispute_window_closed');
      }
      for (const k of d.evidenceKeys ?? []) this.media.assertOwnedBy(k, a.userId!);
      const prevStatus = b.status;
      if (b.status === 'assigned') {
        // Job never started: handled as a no-show cancellation rather than a dispute.
        throw new ValidationError('If the provider has not arrived, use "Report no-show" on the booking instead');
      }
      await this.state.transition(c, BookingMachine, b.id, 'dispute', a);
      const sla = new Date(Date.now() + DISPUTE_SLA_HOURS[d.reasonCode] * 3600_000);
      const dispute = await this.db.one(
        `INSERT INTO disputes (booking_id, raised_by_user_id, raised_by_role, reason_code, description, booking_status_at_open, routed_to, sla_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.id, a.userId, role ?? a.type, d.reasonCode, d.description.trim(), prevStatus, DISPUTE_ROUTING[d.reasonCode], sla], c);
      await this.state.created(c, 'dispute', dispute!.id, 'opened', a, { reason: d.reasonCode });
      if (d.evidenceKeys?.length) {
        await c.query(`INSERT INTO dispute_messages (dispute_id, author_user_id, author_role, body, attachment_keys) VALUES ($1,$2,$3,$4,$5)`,
          [dispute!.id, a.userId, role ?? a.type, 'Evidence attached when opening the dispute', d.evidenceKeys]);
      }
      await this.payouts.setDisputeFlag(c, b.id, true, `dispute: ${d.reasonCode}`);
      await this.audit.log(c, a, 'dispute.open', 'dispute', dispute!.id, null, { reason: d.reasonCode, bookingStatus: prevStatus });
      await this.outbox.emit(c, Events.DisputeOpened, 'booking', b.id, {
        bookingId: b.id, disputeId: dispute!.id, reference: b.reference, customerId: b.customer_id, providerId: b.provider_id, reason: d.reasonCode,
        raisedBy: role, payoutAlreadyReleased: prevStatus === 'payout_released', routedTo: DISPUTE_ROUTING[d.reasonCode],
      }, b.market_id);
      return dispute;
    });
  }

  async get(a: Actor, id: string) {
    const d = await this.db.one(
      `SELECT d.*, b.reference, b.customer_id, b.provider_id, b.agreed_amount, b.currency_code, b.status AS booking_status,
              cu.full_name AS customer_name, pu.full_name AS provider_name
         FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users cu ON cu.id = b.customer_id JOIN users pu ON pu.id = b.provider_id
        WHERE d.id = $1`, [id]);
    if (!d) throw new NotFoundError('Dispute not found');
    const party = d.customer_id === a.userId || d.provider_id === a.userId;
    if (!party && !isStaff(a)) throw new ForbiddenError();
    const messages = await this.db.many(
      `SELECT id, author_user_id, author_role, body, attachment_keys, internal_only, created_at FROM dispute_messages
        WHERE dispute_id = $1 AND ($2 OR NOT internal_only) ORDER BY created_at`, [id, isStaff(a)]);
    const withUrls = await Promise.all(messages.map(async msg => ({
      ...msg, attachments: await Promise.all((msg.attachment_keys ?? []).map((k: string) => this.media.signedGet(k).catch(() => null))),
    })));
    const timeline = await this.state.history('dispute', id);
    return { ...d, messages: withUrls, timeline };
  }

  async message(a: Actor, id: string, d: { body: string; attachmentKeys?: string[]; internalOnly?: boolean }) {
    return this.db.tx(async c => {
      const disp = await this.db.oneOrFail(
        `SELECT d.*, b.customer_id, b.provider_id, b.reference, b.market_id FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE d.id = $1 FOR UPDATE OF d`, [id], c, 'Dispute');
      const role = disp.customer_id === a.userId ? 'customer' : disp.provider_id === a.userId ? 'provider' : null;
      if (!role && !isStaff(a)) throw new ForbiddenError();
      if (['resolved', 'closed'].includes(disp.status)) throw new ConflictError('This dispute is closed');
      for (const k of d.attachmentKeys ?? []) if (!isStaff(a)) this.media.assertOwnedBy(k, a.userId!);
      const msg = await this.db.one(
        `INSERT INTO dispute_messages (dispute_id, author_user_id, author_role, body, attachment_keys, internal_only) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, a.userId, role ?? a.type, d.body.trim(), d.attachmentKeys ?? [], isStaff(a) && !!d.internalOnly], c);
      if (role && disp.status === 'awaiting_evidence') await this.state.transition(c, DisputeMachine, id, 'evidence_submitted', a);
      return msg;
    });
  }

  async startReview(a: Actor, id: string) {
    return this.db.tx(async c => {
      const r = await this.state.transition(c, DisputeMachine, id, 'start_review', a, { set: { assigned_to_user_id: a.userId } });
      await this.audit.log(c, a, 'dispute.start_review', 'dispute', id);
      return r.row;
    });
  }

  async requestEvidence(a: Actor, id: string, d: { message: string; dueInHours?: number }) {
    return this.db.tx(async c => {
      const due = new Date(Date.now() + (d.dueInHours ?? 48) * 3600_000);
      const r = await this.state.transition(c, DisputeMachine, id, 'request_evidence', a, { set: { evidence_due_at: due } });
      await c.query(`INSERT INTO dispute_messages (dispute_id, author_user_id, author_role, body) VALUES ($1,$2,$3,$4)`, [id, a.userId, a.type, d.message]);
      const b = await this.db.one(`SELECT b.id, b.reference, b.customer_id, b.provider_id, b.market_id FROM bookings b JOIN disputes d ON d.booking_id = b.id WHERE d.id = $1`, [id], c);
      await this.outbox.emit(c, Events.DisputeEvidenceRequested, 'booking', b!.id, { disputeId: id, bookingId: b!.id, reference: b!.reference, customerId: b!.customer_id, providerId: b!.provider_id, dueAt: due }, b!.market_id);
      return r.row;
    });
  }

  /**
   * Resolution (§A.10, §C.9). Executed by staff with mandatory notes; settlement is
   * expressed as the ADJUSTED job value (fees recomputed proportionally):
   *   release_to_provider = full value, refund_full = 0, refund_partial/split = in between.
   */
  async resolve(a: Actor, id: string, d: { resolution: DisputeResolution; adjustedAmount?: string; notes: string }) {
    if (!d.notes?.trim() || d.notes.trim().length < 10) throw new ValidationError('Resolution notes (min 10 characters) are mandatory');
    let refundId: string | null = null;
    const result = await this.db.tx(async c => {
      const disp = await this.db.oneOrFail(`SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [id], c, 'Dispute');
      const b = await this.db.oneOrFail(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [disp.booking_id], c, 'Booking');
      if (b.status !== 'disputed') throw new ConflictError(`Booking is ${b.status}, expected disputed`);
      const fb = breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code,
        (await this.db.one(`SELECT fee_bps FROM platform_fees WHERE booking_id = $1`, [b.id], c))!.fee_bps,
        (await this.db.one(`SELECT commission_bps FROM platform_commissions WHERE booking_id = $1`, [b.id], c))!.commission_bps);
      const adjusted = d.resolution === 'release_to_provider' ? fb.agreed
        : d.resolution === 'refund_full' ? money(0, b.currency_code)
        : m(d.adjustedAmount ?? (() => { throw new ValidationError('adjustedAmount is required for partial/split resolutions'); })(), b.currency_code);
      if (['refund_partial', 'split'].includes(d.resolution) && (adjusted.minor <= 0 || adjusted.minor >= fb.agreed.minor)) {
        throw new ValidationError('For a partial or split resolution the adjusted job value must be between 0 and the agreed amount');
      }
      const s = computeSettlement(fb, adjusted);

      // Role limits (§I): support handles low-severity reasons within the goodwill cap; finance handles financial disputes.
      if (a.type === 'support') {
        if (!SUPPORT_RESOLVABLE.includes(disp.reason_code)) throw new ForbiddenError('This dispute type must be resolved by an admin');
        const caps = await this.cfg.get<Record<string, number>>('support_goodwill_cap', {});
        const cap = caps[b.currency_code] ?? 0;
        if (s.refundToCustomer.minor > cap) throw new ForbiddenError(`Refunds above ${b.currency_code} ${(cap / 100).toFixed(2)} need an admin or finance operator`);
      }
      if (a.type === 'finance' && !['overcharge'].includes(disp.reason_code) && disp.source !== 'chargeback') {
        throw new ForbiddenError('Finance operators resolve financial disputes only');
      }

      const payout = await this.db.one(`SELECT * FROM payout_records WHERE booking_id = $1`, [b.id], c);
      const payoutReleased = !!payout && ['released', 'settled'].includes(payout.status);
      await this.state.transition(c, DisputeMachine, id, 'resolve', a, {
        set: { resolution: d.resolution, resolution_amount: n(adjusted), resolution_notes: d.notes.trim(), resolved_by_user_id: a.userId, resolved_at: new Date() },
      });

      if (s.refundToCustomer.minor === 0) {
        // In the provider's favour.
        if (payoutReleased) {
          await this.state.transition(c, BookingMachine, b.id, 'resolve_keep_released', a);
        } else {
          await this.state.transition(c, BookingMachine, b.id, 'resolve_release', a);
          if (payout) await this.payouts.applySettlement(c, b.id, s, { eligibleNow: true });
          else {
            // Disputed before approval: approval is implied by the resolution.
            await c.query(`UPDATE bookings SET approved_at = COALESCE(approved_at, now()) WHERE id = $1`, [b.id]);
            await this.payouts.applySettlement(c, b.id, s, { eligibleNow: true });
          }
        }
      } else {
        await this.state.transition(c, BookingMachine, b.id, 'resolve_refund', a);
        if (!payoutReleased) await this.payouts.applySettlement(c, b.id, s, { eligibleNow: true });
        refundId = await this.payments.createRefund(c, { bookingId: b.id, settlement: s, reason: `Dispute ${d.resolution}: ${d.notes.trim()}`, actor: a, disputeId: id });
      }
      await this.audit.log(c, a, 'dispute.resolve', 'dispute', id, { status: disp.status }, {
        resolution: d.resolution, adjusted: n(adjusted), refund: n(s.refundToCustomer), providerNet: n(s.providerNetAfter), clawback: payoutReleased ? n(s.providerReduction) : '0',
      }, d.notes);
      await this.outbox.emit(c, Events.DisputeResolved, 'booking', b.id, {
        disputeId: id, bookingId: b.id, reference: b.reference, customerId: b.customer_id, providerId: b.provider_id, resolution: d.resolution,
        refund: n(s.refundToCustomer), providerNet: n(s.providerNetAfter), currency: b.currency_code,
      }, b.market_id);
      return { resolution: d.resolution, refundToCustomer: n(s.refundToCustomer), providerPayout: n(s.providerNetAfter), clawback: payoutReleased ? n(s.providerReduction) : '0' };
    });
    if (refundId) await this.payments.processRefund(refundId).catch(e => this.log.warn(`refund ${refundId}: ${e.message}`));
    return result;
  }

  async withdraw(a: Actor, id: string) {
    return this.db.tx(async c => {
      const disp = await this.db.oneOrFail(`SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [id], c, 'Dispute');
      if (disp.raised_by_user_id !== a.userId) throw new ForbiddenError('Only the person who raised the dispute can withdraw it');
      await this.state.transition(c, DisputeMachine, id, 'withdraw', a);
      const payout = await this.db.one(`SELECT status FROM payout_records WHERE booking_id = $1`, [disp.booking_id], c);
      const trig = payout && ['released', 'settled'].includes(payout.status) ? 'resolve_keep_released' : 'resolve_release';
      // Withdrawal restores the pre-dispute path; executed as a system-level resolution.
      await c.query(`INSERT INTO state_events (entity_type, entity_id, from_state, to_state, trigger, actor_type, actor_user_id, metadata)
                     VALUES ('booking',$1,'disputed',$2,'dispute_withdrawn',$3,$4,'{}')`, [disp.booking_id, trig === 'resolve_keep_released' ? 'payout_released' : 'payout_pending', a.type, a.userId]);
      if (trig === 'resolve_keep_released') {
        await c.query(`UPDATE bookings SET status = 'payout_released', version = version + 1 WHERE id = $1`, [disp.booking_id]);
      } else {
        const b = await this.db.one(`SELECT * FROM bookings WHERE id = $1`, [disp.booking_id], c);
        const fb = breakdownFromFrozen(m(b.agreed_amount, b.currency_code).minor, b.currency_code,
          (await this.db.one(`SELECT fee_bps FROM platform_fees WHERE booking_id = $1`, [b.id], c))!.fee_bps,
          (await this.db.one(`SELECT commission_bps FROM platform_commissions WHERE booking_id = $1`, [b.id], c))!.commission_bps);
        await c.query(`UPDATE bookings SET status = 'payout_pending', approved_at = COALESCE(approved_at, now()), version = version + 1 WHERE id = $1`, [b.id]);
        await this.payouts.applySettlement(c, b.id, computeSettlement(fb, fb.agreed), { eligibleNow: !!b.approved_at });
      }
      await this.audit.log(c, a, 'dispute.withdraw', 'dispute', id);
      return { ok: true };
    });
  }

  queue(filter: { status?: string; routedTo?: string; limit?: number }) {
    return this.db.many(
      `SELECT d.*, b.reference, b.agreed_amount, b.currency_code, cu.full_name AS customer_name, pu.full_name AS provider_name,
              (d.sla_due_at < now()) AS sla_breached
         FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users cu ON cu.id = b.customer_id JOIN users pu ON pu.id = b.provider_id
        WHERE ($1::text IS NULL OR d.status::text = $1) AND ($2::text IS NULL OR d.routed_to = $2)
        ORDER BY (d.status IN ('opened','under_review','awaiting_evidence')) DESC, d.sla_due_at LIMIT $3`,
      [filter.status ?? null, filter.routedTo ?? null, Math.min(filter.limit ?? 100, 500)]);
  }

  async mine(a: Actor) {
    return this.db.many(
      `SELECT d.id, d.status, d.reason_code, d.resolution, d.opened_at, b.reference, b.id AS booking_id FROM disputes d JOIN bookings b ON b.id = d.booking_id
        WHERE b.customer_id = $1 OR b.provider_id = $1 ORDER BY d.opened_at DESC LIMIT 50`, [a.userId]);
  }

  /** Scheduler: evidence deadlines → back to review; SLA breaches → staff alert. */
  async sweep(): Promise<number> {
    const due = await this.db.many(`SELECT id FROM disputes WHERE status = 'awaiting_evidence' AND evidence_due_at < now() LIMIT 100`);
    for (const d of due) await this.db.tx(c => this.state.transition(c, DisputeMachine, d.id, 'evidence_deadline', SYSTEM_ACTOR)).catch(() => undefined);
    const closeable = await this.db.many(`SELECT id FROM disputes WHERE status = 'resolved' AND resolved_at < now() - interval '7 days' LIMIT 100`);
    for (const d of closeable) await this.db.tx(c => this.state.transition(c, DisputeMachine, d.id, 'close', SYSTEM_ACTOR)).catch(() => undefined);
    return due.length + closeable.length;
  }
}
