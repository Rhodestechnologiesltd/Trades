import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../common/config';

export interface SendResult { ok: boolean; providerMessageId?: string; error?: string; permanent?: boolean; invalidTokens?: string[] }

/**
 * Push via the Expo push service, which fans out to FCM (Android) and APNs (iOS)
 * through one API — a unified push abstraction (§H). Swap for direct FCM/APNs
 * by implementing the same interface.
 */
@Injectable()
export class PushChannel {
  private readonly log = new Logger('Push');

  async send(tokens: string[], title: string, body: string, data: Record<string, unknown>, opts: { urgent?: boolean } = {}): Promise<SendResult> {
    if (!tokens.length) return { ok: false, error: 'no_push_tokens', permanent: true };
    const messages = tokens.map(to => ({
      to, title, body, data, sound: 'default',
      priority: opts.urgent ? 'high' : 'default',
      channelId: opts.urgent ? 'urgent-jobs' : 'default',
    }));
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          ...(config.notifications.expoAccessToken ? { authorization: `Bearer ${config.notifications.expoAccessToken}` } : {}),
        },
        body: JSON.stringify(messages),
      });
      const json: any = await res.json();
      if (!res.ok) return { ok: false, error: `expo_${res.status}` };
      const tickets: any[] = json.data ?? [];
      const invalidTokens = tickets
        .map((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? tokens[i] : null))
        .filter(Boolean) as string[];
      const anyOk = tickets.some(t => t.status === 'ok');
      return { ok: anyOk, providerMessageId: tickets.find(t => t.id)?.id, invalidTokens, error: anyOk ? undefined : tickets[0]?.message };
    } catch (e: any) {
      this.log.warn(`push failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
}

/** SMS via Twilio REST (or swap for a regional aggregator with local carrier reach). */
@Injectable()
export class SmsChannel {
  private readonly log = new Logger('SMS');

  async send(to: string, body: string): Promise<SendResult> {
    const { twilioSid, twilioToken, twilioFrom } = config.notifications;
    if (!twilioSid) {
      this.log.log(`[dev sms] → ${to}: ${body}`);
      return { ok: true, providerMessageId: 'dev' };
    }
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: twilioFrom, Body: body }).toString(),
      });
      const json: any = await res.json();
      if (!res.ok) return { ok: false, error: json?.message ?? `twilio_${res.status}`, permanent: res.status === 400 };
      return { ok: true, providerMessageId: json.sid };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}

/** Transactional email via SendGrid (receipts, statements, dispute correspondence). */
@Injectable()
export class EmailChannel {
  private readonly log = new Logger('Email');

  async send(to: string, subject: string, text: string, html?: string): Promise<SendResult> {
    if (!config.notifications.sendgridKey) {
      this.log.log(`[dev email] → ${to}: ${subject}`);
      return { ok: true, providerMessageId: 'dev' };
    }
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.notifications.sendgridKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: config.notifications.emailFrom, name: 'Trades' },
          subject,
          content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])],
        }),
      });
      if (!res.ok) return { ok: false, error: `sendgrid_${res.status}`, permanent: res.status === 400 };
      return { ok: true, providerMessageId: res.headers.get('x-message-id') ?? undefined };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
