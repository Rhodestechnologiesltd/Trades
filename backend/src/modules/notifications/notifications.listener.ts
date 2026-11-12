import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DbService } from '../../common/db.service';
import { DomainEvent, Events } from '../../common/outbox.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from './notifications.service';

/**
 * Consumes domain events from the bus and fans them out per spec §H. Business code
 * never calls notification code directly. Each notification is deduped by
 * `${eventId}:${recipient}` so at-least-once delivery from the outbox is safe.
 */
@Injectable()
export class NotificationsListener {
  private readonly log = new Logger('NotifyListener');
  constructor(private readonly svc: NotificationsService, private readonly realtime: RealtimeGateway, private readonly db: DbService) {}

  private async send(evt: DomainEvent, userId: string | null | undefined, key: string, extra: Record<string, unknown> = {}) {
    if (!userId) return;
    await this.svc.notify(userId, key, { ...evt.payload, ...extra }, `${evt.id}:${userId}:${key}`)
      .catch(e => this.log.warn(`notify ${key} → ${userId}: ${e.message}`));
  }

  private live(userIds: Array<string | null | undefined>, evt: DomainEvent) {
    for (const u of userIds) if (u) this.realtime.toUser(u, evt.type, { ...evt.payload, eventId: evt.id });
    if (evt.payload?.bookingId) this.realtime.toBooking(evt.payload.bookingId, evt.type, evt.payload);
  }

  @OnEvent(Events.ProviderNotified, { async: true })
  async providerNotified(e: DomainEvent) {
    await this.send(e, e.payload.providerId, e.payload.urgent ? `${Events.RequestCreated}:provider:urgent` : `${Events.RequestCreated}:provider`);
    this.live([e.payload.providerId], e);
  }
  @OnEvent(Events.RequestDispatched, { async: true })
  async dispatched(e: DomainEvent) { if (e.payload.notified) await this.send(e, e.payload.customerId, Events.RequestDispatched); this.live([e.payload.customerId], e); }
  @OnEvent(Events.RequestExpired, { async: true })
  async expired(e: DomainEvent) {
    await this.send(e, e.payload.customerId, Events.RequestExpired);
    this.live([e.payload.customerId], e);
    if (e.payload.adminAssist) this.realtime.toStaff('ops.admin_assist', e.payload);
  }
  @OnEvent(Events.QuoteSubmitted, { async: true })
  async quote(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.QuoteSubmitted); this.live([e.payload.customerId], e); }
  @OnEvent(Events.CounterOfferProposed, { async: true })
  async counter(e: DomainEvent) { await this.send(e, e.payload.recipientId, Events.CounterOfferProposed); this.live([e.payload.recipientId], e); }
  @OnEvent(Events.CounterOfferResolved, { async: true })
  async counterResolved(e: DomainEvent) { await this.send(e, e.payload.recipientId, Events.CounterOfferResolved); this.live([e.payload.recipientId], e); }
  @OnEvent(Events.QuoteAccepted, { async: true })
  async accepted(e: DomainEvent) {
    await this.send(e, e.payload.providerId, `${Events.QuoteAccepted}:winner`);
    for (const loser of e.payload.loserProviderIds ?? []) await this.send(e, loser, `${Events.QuoteAccepted}:loser`);
    this.live([e.payload.providerId, e.payload.customerId, ...(e.payload.loserProviderIds ?? [])], e);
  }
  @OnEvent(Events.PaymentCaptured, { async: true })
  async captured(e: DomainEvent) {
    await this.send(e, e.payload.customerId, `${Events.PaymentCaptured}:customer`);
    await this.send(e, e.payload.providerId, `${Events.PaymentCaptured}:provider`);
    this.live([e.payload.customerId, e.payload.providerId], e);
  }
  @OnEvent(Events.PaymentFailed, { async: true })
  async payFailed(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.PaymentFailed); this.live([e.payload.customerId], e); }
  @OnEvent(Events.JobEnRoute, { async: true })
  async enRoute(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.JobEnRoute); this.live([e.payload.customerId], e); }
  @OnEvent(Events.JobStarted, { async: true })
  async started(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.JobStarted); this.live([e.payload.customerId], e); }
  @OnEvent(Events.JobCompleted, { async: true })
  async completed(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.JobCompleted); this.live([e.payload.customerId], e); }
  @OnEvent(Events.AutoApproveReminder, { async: true })
  async reminder(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.AutoApproveReminder); }
  @OnEvent(Events.JobApproved, { async: true })
  async approved(e: DomainEvent) { await this.send(e, e.payload.providerId, Events.JobApproved); this.live([e.payload.providerId, e.payload.customerId], e); }
  @OnEvent(Events.PayoutReleased, { async: true })
  async payout(e: DomainEvent) { await this.send(e, e.payload.providerId, Events.PayoutReleased); this.live([e.payload.providerId], e); }
  @OnEvent(Events.PayoutHeld, { async: true })
  async held(e: DomainEvent) { await this.send(e, e.payload.providerId, Events.PayoutHeld); }
  @OnEvent(Events.BookingCancelled, { async: true })
  async cancelled(e: DomainEvent) {
    await this.send(e, e.payload.customerId, Events.BookingCancelled);
    await this.send(e, e.payload.providerId, Events.BookingCancelled, { refund: undefined });
    this.live([e.payload.customerId, e.payload.providerId], e);
  }
  @OnEvent(Events.RefundProcessed, { async: true })
  async refund(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.RefundProcessed); this.live([e.payload.customerId], e); }
  @OnEvent(Events.DisputeOpened, { async: true })
  async disputeOpened(e: DomainEvent) {
    await this.send(e, e.payload.customerId, Events.DisputeOpened);
    await this.send(e, e.payload.providerId, Events.DisputeOpened);
    this.realtime.toStaff('ops.dispute_opened', e.payload); // internal ops alert (§H)
    this.live([e.payload.customerId, e.payload.providerId], e);
  }
  @OnEvent(Events.DisputeEvidenceRequested, { async: true })
  async evidence(e: DomainEvent) { await this.send(e, e.payload.customerId, Events.DisputeEvidenceRequested); await this.send(e, e.payload.providerId, Events.DisputeEvidenceRequested); }
  @OnEvent(Events.DisputeResolved, { async: true })
  async resolved(e: DomainEvent) {
    await this.send(e, e.payload.customerId, Events.DisputeResolved);
    await this.send(e, e.payload.providerId, Events.DisputeResolved);
    this.live([e.payload.customerId, e.payload.providerId], e);
  }
  /** Chargebacks are the most time-sensitive flow: page every finance operator (§F.5). */
  @OnEvent(Events.ChargebackReceived, { async: true })
  async chargeback(e: DomainEvent) {
    this.realtime.toStaff('ops.chargeback', e.payload);
    const finance = await this.db.many(`SELECT id FROM users WHERE user_type = 'finance' AND status = 'active'`);
    for (const f of finance) {
      await this.svc.notify(f.id, Events.DisputeOpened, { ...e.payload, reason: 'chargeback' }, `${e.id}:${f.id}:chargeback`).catch(() => undefined);
    }
  }
  @OnEvent(Events.ReviewPublished, { async: true })
  async review(e: DomainEvent) { await this.send(e, e.payload.revieweeId, Events.ReviewPublished); }
  @OnEvent(Events.ProviderVerified, { async: true })
  async verified(e: DomainEvent) { await this.send(e, e.payload.providerId, Events.ProviderVerified); }
  @OnEvent(Events.ProviderRejected, { async: true })
  async rejected(e: DomainEvent) { await this.send(e, e.payload.providerId, Events.ProviderRejected); }
  @OnEvent(Events.MessageReceived, { async: true })
  async message(e: DomainEvent) { await this.send(e, e.payload.recipientId, Events.MessageReceived); }
}
