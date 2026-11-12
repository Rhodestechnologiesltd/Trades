import { Injectable } from '@nestjs/common';
import { moderateText } from '@trades/domain';
import { Actor, isStaff } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ForbiddenError, ValidationError } from '../../common/errors';
import { Events, OutboxService } from '../../common/outbox.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Customer ↔ provider chat scoped to a request. Contact details are redacted
 * until the booking is paid, keeping the transaction (and its protections) on-platform.
 */
@Injectable()
export class MessagingService {
  constructor(private readonly db: DbService, private readonly outbox: OutboxService, private readonly realtime: RealtimeGateway, private readonly limits: RateLimitService) {}

  private async participants(requestId: string) {
    const r = await this.db.one(
      `SELECT r.customer_id, b.provider_id AS booked_provider, b.status AS booking_status,
              ARRAY(SELECT provider_id FROM quotes WHERE service_request_id = r.id) AS quoting
         FROM service_requests r LEFT JOIN bookings b ON b.service_request_id = r.id WHERE r.id = $1`, [requestId]);
    if (!r) throw new ForbiddenError();
    return r;
  }

  async send(a: Actor, requestId: string, body: string, toProviderId?: string) {
    if (!body?.trim() || body.length > 2000) throw new ValidationError('Message must be 1–2000 characters');
    await this.limits.enforce(`msg:${a.userId}`, 60, 600);
    const p = await this.participants(requestId);
    let recipient: string;
    if (a.userId === p.customer_id) {
      recipient = toProviderId ?? p.booked_provider;
      if (!recipient || !(p.quoting as string[]).includes(recipient)) throw new ValidationError('Choose a provider who has quoted');
    } else if ((p.quoting as string[]).includes(a.userId!)) {
      recipient = p.customer_id;
    } else throw new ForbiddenError();
    const paid = p.booked_provider && [a.userId, recipient].includes(p.booked_provider) &&
      !['payment_pending', 'cancelled', 'refunded'].includes(p.booking_status);
    const mod = paid ? { text: body.trim(), redacted: false } : moderateText(body.trim());
    const msg = await this.db.tx(async c => {
      const row = await this.db.one(
        `INSERT INTO booking_messages (service_request_id, sender_user_id, recipient_user_id, body, redacted) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [requestId, a.userId, recipient, mod.text, mod.redacted], c);
      const sender = await this.db.one(`SELECT full_name FROM users WHERE id = $1`, [a.userId], c);
      await this.outbox.emit(c, Events.MessageReceived, 'service_request', requestId, {
        requestId, messageId: row!.id, recipientId: recipient, senderName: sender?.full_name, preview: mod.text,
        deepLink: a.type === 'customer' ? `trades-provider://requests/${requestId}/chat` : `trades://requests/${requestId}/chat`,
      });
      return row!;
    });
    this.realtime.toUser(recipient, 'message', msg);
    return msg;
  }

  async thread(a: Actor, requestId: string, withUserId?: string) {
    const p = await this.participants(requestId);
    const isParty = a.userId === p.customer_id || (p.quoting as string[]).includes(a.userId!);
    if (!isParty && !isStaff(a)) throw new ForbiddenError();
    const other = a.userId === p.customer_id ? withUserId : p.customer_id;
    const rows = await this.db.many(
      `SELECT id, sender_user_id, recipient_user_id, body, redacted, read_at, created_at FROM booking_messages
        WHERE service_request_id = $1 AND ($2::uuid IS NULL OR sender_user_id = $2 OR recipient_user_id = $2)
          AND ($3::boolean OR sender_user_id = $4 OR recipient_user_id = $4)
        ORDER BY created_at LIMIT 500`, [requestId, other ?? null, isStaff(a), a.userId]);
    await this.db.pool.query(`UPDATE booking_messages SET read_at = now() WHERE service_request_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`, [requestId, a.userId]);
    return rows;
  }
}
