import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../common/config';
import { CreateSessionInput, CreateSessionResult, NormalizedGatewayEvent, PaymentGateway, RefundInput, RefundResult } from './gateway';

/**
 * MIPS (Mauritius) adapter — direct-capture gateway (spec §0, §F.1).
 *
 * ⚠️ INTEGRATION CHECKPOINT (spec "Key Risks": highest-uncertainty integration).
 * Endpoint paths and payload field names below follow the MIPS merchant API pattern
 * (payment zone → encrypted Instant Merchant Notification → server-side decryption),
 * but MUST be confirmed against the integration pack MIPS issues during merchant
 * onboarding before go-live: exact endpoint names, IMN field names, refund API
 * availability/window, and status-query support. Every value is isolated here and in
 * env config so confirming them requires no change elsewhere.
 *
 * Flow:
 *  1. createSession → POST {base}/api/load_payment_zone → returns iframe HTML; we serve
 *     it from GET /v1/payments/mips/zone/:paymentId (the redirectUrl the app opens).
 *  2. MIPS POSTs an encrypted callback (IMN) to /v1/payments/mips/callback.
 *  3. parseWebhook → POST {base}/api/decrypt_imn_data. Only MIPS can produce a payload
 *     that decrypts with our merchant keys, which authenticates the callback; we
 *     additionally check order id + amount + currency against our payment row.
 */
@Injectable()
export class MipsGateway implements PaymentGateway {
  readonly name = 'mips';
  private readonly log = new Logger('MIPS');
  private readonly zones = new Map<string, string>(); // paymentId → iframe HTML (short-lived; also persisted by caller)

  private get authentify() {
    const m = config.payment.mips;
    return { id_merchant: m.merchantId, id_entity: m.entityId, id_operator: m.operatorId, operator_password: m.operatorPassword };
  }

  private async call(path: string, body: unknown): Promise<any> {
    const m = config.payment.mips;
    const res = await fetch(`${m.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json',
        authorization: 'Basic ' + Buffer.from(`${m.apiUsername}:${m.apiPassword}`).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MIPS ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async createSession(i: CreateSessionInput): Promise<CreateSessionResult> {
    // MIPS redirects the browser to an https URL; app deep links (trades://…) go through our return page.
    const returnUrl = /^https?:\/\//.test(i.returnUrl) ? i.returnUrl : `${config.publicApiUrl}/v1/payments/return`;
    const res = await this.call('/api/load_payment_zone', {
      authentify: this.authentify,
      order: { id_order: i.paymentId, currency: i.currency, amount: Number(i.amount) },
      iframe_behavior: { height: 400, width: 350, custom_redirection_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}paymentId=${i.paymentId}`, language: (i.locale ?? 'EN').toUpperCase() },
      request_mode: 'simple',
      touchpoint: 'native_app',
    });
    const html = res?.answer?.payment_zone_data ?? res?.payment_zone_data;
    if (!html) throw new Error('MIPS did not return a payment zone');
    this.zones.set(i.paymentId, html);
    return { sessionId: i.paymentId, redirectUrl: `${config.publicApiUrl}/v1/payments/mips/zone/${i.paymentId}`, expiresAt: new Date(Date.now() + 30 * 60_000) };
  }

  zoneHtml(paymentId: string) { return this.zones.get(paymentId); }

  async parseWebhook(_headers: Record<string, any>, _raw: Buffer, body: any): Promise<NormalizedGatewayEvent | null> {
    const crypted = body?.crypted_callback ?? body?.received_crypted_data;
    if (!crypted) return null;
    let data: any;
    try {
      data = await this.call('/api/decrypt_imn_data', {
        authentify: this.authentify,
        salt: config.payment.mips.webhookSecret,
        cipher_key: config.payment.mips.webhookSecret,
        received_crypted_data: crypted,
      });
    } catch (e: any) {
      this.log.warn(`IMN decryption failed: ${e.message}`);
      return null; // unauthenticated
    }
    const status = String(data?.status ?? data?.transaction_status ?? '').toLowerCase();
    const ok = ['success', 'successful', 'approved', 'paid'].includes(status);
    return {
      eventId: String(data?.transaction_id ?? data?.id_transaction ?? `${data?.id_order}:${status}`),
      type: ok ? 'payment.succeeded' : 'payment.failed',
      paymentId: String(data?.id_order),
      gatewayReference: data?.transaction_id ?? data?.id_transaction,
      amount: data?.amount !== undefined ? Number(data.amount).toFixed(2) : undefined,
      currency: data?.currency,
      cardBrand: data?.card_type ?? data?.brand,
      cardLast4: data?.card_last_digits ?? data?.last4,
      failureCode: ok ? undefined : status || 'declined',
      failureMessage: ok ? undefined : data?.message,
      raw: data,
    };
  }

  async fetchStatus(paymentId: string): Promise<NormalizedGatewayEvent | null> {
    // CONFIRM WITH MIPS: transaction status query endpoint name/fields.
    try {
      const data = await this.call('/api/get_payment_status', { authentify: this.authentify, id_order: paymentId });
      if (!data || data.status === undefined) return null;
      const st = String(data.status).toLowerCase();
      if (['pending', 'processing', 'initiated'].includes(st)) return null;
      return {
        eventId: `poll:${paymentId}:${st}`,
        type: ['success', 'successful', 'approved', 'paid'].includes(st) ? 'payment.succeeded' : 'payment.failed',
        paymentId, gatewayReference: data.transaction_id, amount: data.amount !== undefined ? Number(data.amount).toFixed(2) : undefined,
        currency: data.currency, raw: data,
      };
    } catch (e: any) {
      this.log.warn(`status poll failed for ${paymentId}: ${e.message}`);
      return null;
    }
  }

  async refund(i: RefundInput): Promise<RefundResult> {
    // CONFIRM WITH MIPS: refund API availability and window. If unsupported or outside the
    // window, return 'unsupported' and the platform refunds via bank transfer from reserve (§F.5).
    try {
      const data = await this.call('/api/refund_request', {
        authentify: this.authentify, id_order: i.paymentId, transaction_id: i.gatewayReference,
        amount: Number(i.amount), currency: i.currency, reference: i.idempotencyKey,
      });
      const st = String(data?.status ?? '').toLowerCase();
      if (['success', 'approved', 'refunded'].includes(st)) return { status: 'succeeded', refundReference: data?.refund_id ?? data?.transaction_id };
      if (['pending', 'processing'].includes(st)) return { status: 'pending', refundReference: data?.refund_id };
      return { status: 'failed', error: data?.message ?? st };
    } catch (e: any) {
      if (/HTTP 404|HTTP 405/.test(e.message)) return { status: 'unsupported', error: e.message };
      return { status: 'failed', error: e.message };
    }
  }
}
