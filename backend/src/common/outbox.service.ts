import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { config } from './config';
import { DbService, Queryable } from './db.service';

/** Domain event names published on the bus (spec §B.2 "Booking/Request Service publishes domain events"). */
export const Events = {
  RequestCreated: 'request.created',
  RequestDispatched: 'request.dispatched',
  RequestExpired: 'request.expired',
  RequestCancelled: 'request.cancelled',
  ProviderNotified: 'dispatch.provider_notified',
  QuoteSubmitted: 'quote.submitted',
  QuoteWithdrawn: 'quote.withdrawn',
  CounterOfferProposed: 'counter_offer.proposed',
  CounterOfferResolved: 'counter_offer.resolved',
  QuoteAccepted: 'quote.accepted',
  BookingCreated: 'booking.created',
  PaymentCaptured: 'payment.captured',
  PaymentFailed: 'payment.failed',
  JobStarted: 'job.started',
  JobEnRoute: 'job.en_route',
  JobCompleted: 'job.completed',
  AutoApproveReminder: 'job.auto_approve_reminder',
  JobApproved: 'job.approved',
  PayoutScheduled: 'payout.scheduled',
  PayoutReleased: 'payout.released',
  PayoutHeld: 'payout.held',
  BookingCancelled: 'booking.cancelled',
  RefundProcessed: 'refund.processed',
  DisputeOpened: 'dispute.opened',
  DisputeEvidenceRequested: 'dispute.evidence_requested',
  DisputeResolved: 'dispute.resolved',
  ChargebackReceived: 'chargeback.received',
  ReviewPublished: 'review.published',
  ProviderVerified: 'provider.verified',
  ProviderRejected: 'provider.rejected',
  MessageReceived: 'message.received',
  ProviderLocation: 'provider.location',
} as const;
export type EventName = typeof Events[keyof typeof Events];

export interface DomainEvent<P = any> {
  id: number;
  type: EventName;
  aggregateType: string;
  aggregateId: string;
  payload: P;
  marketId?: string | null;
  createdAt: string;
}

/**
 * Transactional outbox (§B.3 event-driven core): events are INSERTed in the same
 * transaction as the state change, so they are never lost or emitted for a
 * rolled-back change. A relay publishes them to in-process listeners and,
 * when KAFKA_BROKERS is set, to Kafka (topic per event type) for analytics and
 * independently-deployed consumers. Delivery is at-least-once: consumers dedupe
 * by event id.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Outbox');
  private timer?: NodeJS.Timeout;
  private running = false;
  private kafkaProducer: any = null;

  constructor(private readonly db: DbService, private readonly bus: EventEmitter2) {}

  async emit(q: Queryable, type: EventName, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, marketId?: string | null) {
    await q.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, market_id) VALUES ($1,$2,$3,$4,$5)`,
      [type, aggregateType, aggregateId, JSON.stringify(payload), marketId ?? null],
    );
  }

  async onApplicationBootstrap() {
    if (process.env.OUTBOX_RELAY === 'false') return;
    if (config.kafkaBrokers.length) {
      const { Kafka } = await import('kafkajs');
      this.kafkaProducer = new Kafka({ clientId: 'trades-api', brokers: config.kafkaBrokers }).producer({ idempotent: true });
      await this.kafkaProducer.connect();
    }
    this.timer = setInterval(() => void this.relay(), 500);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.kafkaProducer?.disconnect();
  }

  /** Publishes a batch of unpublished events; SKIP LOCKED lets several API instances relay concurrently. */
  async relay(batch = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.db.tx(async c => {
        const rows = await this.db.many(
          `SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch], c);
        for (const r of rows) {
          const evt: DomainEvent = {
            id: r.id, type: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
            payload: r.payload, marketId: r.market_id, createdAt: r.created_at,
          };
          try {
            if (this.kafkaProducer) {
              await this.kafkaProducer.send({ topic: `trades.${r.event_type}`, messages: [{ key: r.aggregate_id, value: JSON.stringify(evt) }] });
            }
            await this.bus.emitAsync(r.event_type, evt);
            await c.query(`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [r.id]);
          } catch (e: any) {
            this.log.warn(`event ${r.id} ${r.event_type} failed: ${e?.message}`);
            await c.query(`UPDATE outbox_events SET attempts = attempts + 1 WHERE id = $1`, [r.id]);
          }
        }
        return rows.length;
      });
    } finally {
      this.running = false;
    }
  }
}
