import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Actor, CurrentActor, Public, Roles } from '../../common/auth';
import { config } from '../../common/config';
import { DbService } from '../../common/db.service';
import { NotFoundError } from '../../common/errors';
import { Idempotent } from '../../common/idempotency.interceptor';
import { MipsGateway } from './mips.gateway';
import { PaymentsService } from './payments.service';
import { SandboxGateway } from './sandbox.gateway';

class InitiateDto { @IsOptional() @IsString() returnUrl?: string; }
class SandboxCompleteDto { @IsIn(['succeeded', 'failed']) outcome!: 'succeeded' | 'failed'; }

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

@ApiTags('payments')
@Controller('v1')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService, private readonly sandbox: SandboxGateway, private readonly mips: MipsGateway, private readonly db: DbService) {}

  /** Creates the payment intent and returns the hosted-page URL (§E). */
  @Roles('customer') @Post('bookings/:id/payment') @HttpCode(200) @Idempotent()
  initiate(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() d: InitiateDto) { return this.svc.initiate(a, id, d.returnUrl); }

  /** MIPS server-to-server callback (IMN). Authenticated by decryption with merchant keys. */
  @Public() @Post('payments/mips/callback') @HttpCode(200)
  async mipsCallback(@Req() req: any, @Headers() headers: Record<string, any>) {
    const r = await this.svc.handleWebhook('mips', headers, req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), req.body);
    return { received: r.ok };
  }

  @Get('payments/:id/verify')
  verify(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.verify(a, id); }

  /** Wrapper page that renders the MIPS payment zone iframe inside the app's WebView. */
  @Public() @Get('payments/mips/zone/:paymentId')
  async mipsZone(@Param('paymentId', ParseUUIDPipe) id: string, @Res() res: any) {
    const html = this.mips.zoneHtml(id);
    if (!html) throw new NotFoundError('Payment session expired. Please start the payment again.');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure payment</title>
      <style>body{font-family:system-ui;margin:0;padding:16px;background:#f6f7f9}h1{font-size:18px}</style></head>
      <body><h1>Secure card payment</h1><p>Processed by MIPS. Your card details never reach Trades.</p>${html}</body></html>`);
  }

  /** Where the browser lands after the hosted page. The app polls /verify; this page just hands control back. */
  @Public() @Get('payments/return')
  returnPage(@Query('paymentId') paymentId: string, @Res() res: any) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:system-ui;padding:24px"><p>Payment submitted. You can return to the app.</p>
      <script>location.href='trades://payment-return?paymentId=${esc(String(paymentId ?? ''))}'</script></body></html>`);
  }

  /* ───────────── sandbox gateway (non-production only) ───────────── */

  @Public() @Get('payments/sandbox/:sessionId')
  sandboxPage(@Param('sessionId') sid: string, @Res() res: any) {
    if (config.isProd) throw new NotFoundError();
    const s = this.sandbox.session(sid);
    if (!s) throw new NotFoundError('Unknown sandbox session');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox payment</title>
<style>body{font-family:system-ui;max-width:420px;margin:0 auto;padding:24px;background:#f5f6f8;color:#111}
.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.amt{font-size:30px;font-weight:700;margin:6px 0 18px}
button{width:100%;padding:14px;border:0;border-radius:10px;font-size:16px;font-weight:600;margin-top:10px;cursor:pointer}
.ok{background:#0e7c5a;color:#fff}.ko{background:#eee;color:#a11}.tag{display:inline-block;background:#fff3cd;color:#7a5a00;border-radius:6px;padding:2px 8px;font-size:12px}</style></head>
<body><div class="card"><span class="tag">SANDBOX — no real money</span><p>Pay Trades</p><div class="amt">${esc(s.currency)} ${esc(s.amount)}</div>
<p style="color:#555;font-size:14px">Card •••• 4242 (test)</p>
<button class="ok" onclick="go('succeeded')">Pay now</button><button class="ko" onclick="go('failed')">Simulate decline</button></div>
<script>function go(o){fetch(location.pathname+'/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:o})})
.then(r=>r.json()).then(j=>{document.body.innerHTML='<div class="card"><h2>'+(o==='succeeded'?'Payment approved':'Payment declined')+'</h2><p>Returning to the app…</p></div>';setTimeout(()=>location.href=j.returnUrl,600)})}</script></body></html>`);
  }

  @Public() @Post('payments/sandbox/:sessionId/complete') @HttpCode(200)
  async sandboxComplete(@Param('sessionId') sid: string, @Body() d: SandboxCompleteDto) {
    if (config.isProd) throw new NotFoundError();
    const cb = this.sandbox.buildCallback(sid, d.outcome);
    // Simulates the acquirer's server-to-server callback (signed), exactly like a real webhook.
    await this.svc.handleWebhook('sandbox', { 'x-sandbox-signature': cb.signature }, cb.raw, cb.body);
    const sep = cb.returnUrl.includes('?') ? '&' : '?';
    return { ok: true, returnUrl: `${cb.returnUrl}${sep}paymentId=${cb.body.order_id}` };
  }

  /** Signed sandbox webhook endpoint (for integration tests replaying callbacks). */
  @Public() @Post('payments/sandbox/callback') @HttpCode(200)
  async sandboxCallback(@Req() req: any, @Headers() headers: Record<string, any>) {
    if (config.isProd) throw new NotFoundError();
    const r = await this.svc.handleWebhook('sandbox', headers, req.rawBody, req.body);
    return { received: r.ok };
  }

  @Get('payments/:id/resume')
  async resume(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.db.oneOrFail(`SELECT p.gateway_session_id, b.customer_id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = $1`, [id], undefined, 'Payment');
    if (p.customer_id !== a.userId) throw new NotFoundError();
    return { redirectUrl: p.gateway_session_id };
  }
}
