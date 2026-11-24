import { Injectable } from '@nestjs/common';
import { Actor } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ForbiddenError } from '../../common/errors';
import { decodeCursor, toPage } from '../../common/pagination';

@Injectable()
export class ConversationsService {
  constructor(private readonly db: DbService) {}

  async list(actor: Actor) {
    const rows = await this.db.many(
      `WITH messages AS (
         SELECT m.*, CASE WHEN sender_user_id = $1 THEN recipient_user_id ELSE sender_user_id END AS other_id
         FROM booking_messages m WHERE sender_user_id = $1 OR recipient_user_id = $1
       ), latest AS (
         SELECT DISTINCT ON (other_id) * FROM messages
         ORDER BY other_id, created_at DESC, id DESC
       ), unread AS (
         SELECT other_id, count(*)::int AS count FROM messages
         WHERE recipient_user_id = $1 AND read_at IS NULL GROUP BY other_id
       )
       SELECT l.other_id AS "userId", u.full_name AS name, l.body AS preview,
              l.created_at AS "updatedAt", r.title AS "requestTitle",
              COALESCE(unread.count, 0) AS "unreadCount"
       FROM latest l JOIN users u ON u.id = l.other_id
       JOIN service_requests r ON r.id = l.service_request_id
       LEFT JOIN unread ON unread.other_id = l.other_id
       ORDER BY l.created_at DESC, l.id DESC`, [actor.userId]);
    return rows;
  }

  async messages(actor: Actor, otherId: string, cursor?: string) {
    const exists = await this.db.one(
      `SELECT 1 FROM booking_messages
       WHERE (sender_user_id = $1 AND recipient_user_id = $2)
          OR (sender_user_id = $2 AND recipient_user_id = $1) LIMIT 1`,
      [actor.userId, otherId]);
    if (!exists) throw new ForbiddenError('Conversation not found');
    const current = decodeCursor(cursor);
    return this.db.tx(async client => {
      const rows = await this.db.many(
        `SELECT m.id, m.sender_user_id, m.recipient_user_id, m.body, m.created_at,
                m.service_request_id AS "requestId", r.title AS "requestTitle"
         FROM booking_messages m JOIN service_requests r ON r.id = m.service_request_id
         WHERE ((m.sender_user_id = $1 AND m.recipient_user_id = $2)
             OR (m.sender_user_id = $2 AND m.recipient_user_id = $1))
           AND ($3::timestamptz IS NULL OR (m.created_at, m.id) < ($3::timestamptz, $4::uuid))
         ORDER BY m.created_at DESC, m.id DESC LIMIT 51`,
        [actor.userId, otherId, current?.ts ?? null, current?.id ?? null], client);
      const page = toPage(rows, 50);
      const ids = page.items.map(message => message.id);
      await client.query(
        'UPDATE booking_messages SET read_at = now() WHERE id = ANY($1::uuid[]) AND recipient_user_id = $2 AND read_at IS NULL',
        [ids, actor.userId]);
      await client.query(
        `UPDATE notifications SET read_at = now(), status = 'read'
         WHERE recipient_user_id = $1 AND channel = 'in_app' AND read_at IS NULL
           AND event_type = 'message.received' AND payload->>'messageId' = ANY($2::text[])`,
        [actor.userId, ids]);
      const person = await this.db.one('SELECT full_name AS name FROM users WHERE id = $1', [otherId], client);
      const requests = await this.db.many(
        `SELECT r.id, r.title FROM service_requests r
         WHERE (r.customer_id = $1 AND EXISTS (
           SELECT 1 FROM quotes q WHERE q.service_request_id = r.id AND q.provider_id = $2
         )) OR (r.customer_id = $2 AND EXISTS (
           SELECT 1 FROM quotes q WHERE q.service_request_id = r.id AND q.provider_id = $1
         )) ORDER BY r.created_at DESC, r.id DESC`, [actor.userId, otherId], client);
      return { ...page, name: person?.name ?? '', requests };
    });
  }
}
