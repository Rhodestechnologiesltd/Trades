import { Injectable, Logger } from '@nestjs/common';
import { DbService, Queryable } from '../../common/db.service';
import { clampLimit, decodeCursor, toPage } from '../../common/pagination';
import { EmailChannel, PushChannel, SmsChannel } from './channels';
import { DEFAULT_CHANNELS, MANDATORY, render } from './templates';

const MAX_ATTEMPTS = 6;

/**
 * Persists one notifications row per (recipient, channel) and delivers them with
 * exponential backoff. Rows that exhaust retries stay 'failed' (dead-letter) and
 * are surfaced on the ops dashboard (§H). In-app rows are the durable fallback feed.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');

  constructor(private readonly db: DbService, private readonly push: PushChannel, private readonly sms: SmsChannel, private readonly email: EmailChannel) {}

  async notify(recipientUserId: string, templateKey: string, payload: Record<string, unknown>, dedupeKey: string, q: Queryable = this.db.pool) {
    const defaults = DEFAULT_CHANNELS[templateKey] ?? ['in_app'];
    let channels = defaults;
    if (!MANDATORY.has(templateKey)) {
      const pref = await this.db.one(`SELECT channels FROM notification_preferences WHERE user_id = $1 AND event_type = $2`, [recipientUserId, templateKey.split(':')[0]], q);
      if (pref) channels = Array.from(new Set<any>([...pref.channels, 'in_app']));
    }
    // Only queue channels the recipient can actually receive (no email on file → no email row).
    const reach = await this.db.one(
      `SELECT u.email IS NOT NULL AS email, u.phone_number IS NOT NULL AS sms,
              EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = u.id AND t.disabled_at IS NULL) AS push
         FROM users u WHERE u.id = $1`, [recipientUserId], q);
    if (!reach) return;
    channels = channels.filter(ch => ch === 'in_app' || reach[ch]);
    const r = render(templateKey, payload);
    for (const ch of channels) {
      await q.query(
        `INSERT INTO notifications (recipient_user_id, channel, event_type, title, body, payload, status, dedupe_key, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key, channel) DO NOTHING`,
        [recipientUserId, ch, templateKey, r.title, r.body, JSON.stringify({ ...payload, deepLink: r.deepLink }),
         ch === 'in_app' ? 'delivered' : 'queued', dedupeKey, ch === 'in_app' ? new Date() : null]);
    }
  }

  /** Delivery worker: claims due rows (SKIP LOCKED), sends, records outcome + backoff. */
  async deliverDue(batch = 100): Promise<number> {
    const rows = await this.db.tx(c => this.db.many(
      `UPDATE notifications SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (SELECT id FROM notifications WHERE status = 'queued' AND next_attempt_at <= now()
                     ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [batch], c));
    for (const n of rows) {
      const result = await this.deliverOne(n).catch((e: any) => ({ ok: false, error: e.message } as any));
      if (result.ok) {
        await this.db.pool.query(`UPDATE notifications SET status = 'sent', sent_at = now(), provider_message_id = $2, last_error = NULL WHERE id = $1`, [n.id, result.providerMessageId ?? null]);
      } else {
        const dead = result.permanent || n.attempts >= MAX_ATTEMPTS;
        const backoffSec = Math.min(3600, 15 * 2 ** n.attempts);
        await this.db.pool.query(
          `UPDATE notifications SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [n.id, dead ? 'failed' : 'queued', result.error ?? 'unknown', backoffSec]);
        if (dead) this.log.warn(`notification ${n.id} (${n.channel}/${n.event_type}) dead-lettered: ${result.error}`);
      }
      if (result.invalidTokens?.length) {
        await this.db.pool.query(`UPDATE push_tokens SET disabled_at = now() WHERE token = ANY($1)`, [result.invalidTokens]);
      }
    }
    return rows.length;
  }

  private async deliverOne(n: any) {
    const user = await this.db.one(`SELECT phone_number, email FROM users WHERE id = $1`, [n.recipient_user_id]);
    if (!user) return { ok: false, error: 'no_user', permanent: true };
    switch (n.channel) {
      case 'push': {
        const tokens = (await this.db.many(`SELECT token FROM push_tokens WHERE user_id = $1 AND disabled_at IS NULL`, [n.recipient_user_id])).map(t => t.token);
        return this.push.send(tokens, n.title, n.body, { ...n.payload, notificationId: n.id }, { urgent: String(n.event_type).includes('urgent') });
      }
      case 'sms':
        if (!user.phone_number) return { ok: false, error: 'no_phone', permanent: true };
        return this.sms.send(user.phone_number, `${n.title}: ${n.body}`);
      case 'email':
        if (!user.email) return { ok: false, error: 'no_email', permanent: true };
        return this.email.send(user.email, n.title, n.body);
      default:
        return { ok: true };
    }
  }

  /* ───────────── in-app feed ───────────── */

  async feed(userId: string, cursor?: string, limit?: number) {
    const lim = clampLimit(limit);
    const cur = decodeCursor(cursor);
    const rows = await this.db.many(
      `SELECT id, event_type, title, body, payload, read_at, created_at FROM notifications
        WHERE recipient_user_id = $1 AND channel = 'in_app'
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`, [userId, cur?.ts ?? null, cur?.id ?? null, lim + 1]);
    const unread = await this.db.one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [userId]);
    return { ...toPage(rows, lim), unreadCount: unread!.n };
  }

  async markRead(userId: string, id?: string) {
    await this.db.pool.query(
      `UPDATE notifications SET read_at = now(), status = 'read' WHERE recipient_user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2)`,
      [userId, id ?? null]);
    return { ok: true };
  }

  async registerPushToken(userId: string, token: string, platform: string) {
    await this.db.pool.query(
      `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, disabled_at = NULL`,
      [userId, token, platform]);
    return { ok: true };
  }

  async setPreferences(userId: string, prefs: Array<{ eventType: string; channels: string[] }>) {
    await this.db.tx(async c => {
      for (const p of prefs) {
        await c.query(
          `INSERT INTO notification_preferences (user_id, event_type, channels) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, event_type) DO UPDATE SET channels = EXCLUDED.channels`, [userId, p.eventType, p.channels]);
      }
    });
    return this.db.many(`SELECT event_type, channels FROM notification_preferences WHERE user_id = $1`, [userId]);
  }
}
