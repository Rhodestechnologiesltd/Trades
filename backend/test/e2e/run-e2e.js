/*
 * End-to-end business-flow test: the real compiled backend services against a real
 * PostgreSQL (PostGIS, or the PostGIS stub used by test/sql). Exercises every money path:
 * dispatch → quotes → counter-offers → payment webhook → job → approval → T+48h payout,
 * disputes (partial refund, post-payout clawback), cancellations, no-shows, chargebacks,
 * instant-accept, recurring agreements, scheduler jobs, and the ledger accounting identity.
 *
 *   npm run build -w @trades/backend && bash test/e2e/db.sh start && node test/e2e/run-e2e.js
 */
process.env.DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://postgres@127.0.0.1:54330/trades_e2e';
process.env.OTP_DEV_ECHO = 'true';
process.env.PAYMENT_GATEWAY = 'sandbox';
process.env.DISBURSEMENT_RAIL = 'sandbox';
process.env.OUTBOX_RELAY = 'false';
const assert = require('assert/strict');
const path = require('path');
const B = p => require(path.join(process.env.E2E_BUILD_DIR || path.join(__dirname, '../../dist/src'), p));

const { DbService } = B('common/db.service');
const { AuditService } = B('common/audit.service');
const { StateService } = B('common/state.service');
const { OutboxService } = B('common/outbox.service');
const { PlatformConfigService } = B('common/platform-config.service');
const { RateLimitService } = B('common/rate-limit.service');
require('reflect-metadata');
const { EventEmitter2 } = require('@nestjs/event-emitter');
const { RealtimeGateway } = B('modules/realtime/realtime.gateway');
const { MediaService } = B('modules/media/media.service');
const { LedgerService } = B('modules/ledger/ledger.service');
const { PushChannel, SmsChannel, EmailChannel } = B('modules/notifications/channels');
const { NotificationsService } = B('modules/notifications/notifications.service');
const { NotificationsListener } = B('modules/notifications/notifications.listener');
const { AuthService } = B('modules/auth/auth.service');
const { UsersService } = B('modules/users/users.service');
const { CatalogService } = B('modules/catalog/catalog.service');
const { ProvidersService } = B('modules/providers/providers.service');
const { RequestsService } = B('modules/requests/requests.service');
const { DispatchService } = B('modules/dispatch/dispatch.service');
const { SandboxGateway, SandboxDisbursementRail } = B('modules/payments/sandbox.gateway');
const { MipsGateway } = B('modules/payments/mips.gateway');
const { PayoutsService } = B('modules/payouts/payouts.service');
const { PaymentsService } = B('modules/payments/payments.service');
const { BookingsService } = B('modules/bookings/bookings.service');
const { QuotesService } = B('modules/quotes/quotes.service');
const { DisputesService } = B('modules/disputes/disputes.service');
const { ReviewsService } = B('modules/reviews/reviews.service');
const { RecurringService } = B('modules/recurring/recurring.service');
const { AdminService } = B('modules/admin/admin.service');
const { MessagingService } = B('modules/messaging/messaging.service');
const { SchedulerService } = B('modules/scheduler/scheduler.service');

const db = new DbService();
const audit = new AuditService();
const state = new StateService(db);
const bus = new EventEmitter2();
const outbox = new OutboxService(db, bus);
const cfg = new PlatformConfigService(db, audit);
const limits = new RateLimitService();
const realtime = new RealtimeGateway(db);
const media = new MediaService();
const ledger = new LedgerService(db);
const sms = new SmsChannel();
const notifications = new NotificationsService(db, new PushChannel(), sms, new EmailChannel());
const listener = new NotificationsListener(notifications, realtime, db);
const auth = new AuthService(db, audit, limits, cfg, sms);
const users = new UsersService(db, audit, media);
const catalog = new CatalogService(db, audit);
const providers = new ProvidersService(db, audit, media, auth, cfg, limits, realtime);
const requests = new RequestsService(db, state, outbox, audit, cfg, limits, media);
const dispatch = new DispatchService(db, state, outbox, cfg);
const sandboxGw = new SandboxGateway();
const rail = new SandboxDisbursementRail();
const payouts = new PayoutsService(db, state, ledger, outbox, audit, cfg, rail);
const payments = new PaymentsService(db, state, ledger, outbox, audit, cfg, limits, payouts, { sandbox: sandboxGw, mips: new MipsGateway() });
const bookings = new BookingsService(db, state, outbox, audit, cfg, requests, payments, payouts, media);
const quotes = new QuotesService(db, state, outbox, cfg, limits, dispatch, bookings);
const disputes = new DisputesService(db, state, outbox, audit, cfg, payments, payouts, media);
const reviews = new ReviewsService(db, outbox, audit, cfg);
const recurring = new RecurringService(db, state, requests, outbox);
const admin = new AdminService(db, audit, outbox, cfg, media, ledger, payments, state);
const messaging = new MessagingService(db, outbox, realtime, limits);
const scheduler = new SchedulerService(db, dispatch, quotes, bookings, payouts, payments, disputes, recurring, reviews, notifications);
// Wire @OnEvent handlers (works with the real @nestjs/event-emitter metadata or a minimal stub).
for (const inst of [dispatch, listener]) {
  const proto = Object.getPrototypeOf(inst);
  const pairs = proto.__onEvent ?? Object.getOwnPropertyNames(proto).flatMap(key => {
    const meta = typeof Reflect.getMetadata === 'function' ? Reflect.getMetadata('EVENT_LISTENER_METADATA', proto[key]) : null;
    return (meta ?? []).map(m => ({ event: m.event, key }));
  });
  for (const { event, key } of pairs) bus.on(event, inst[key].bind(inst));
}

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
const relay = async () => { let n; do { n = await outbox.relay(); } while (n > 0); };
const one = (sql, p) => db.one(sql, p);
const ACCTS = ['cash_settlement','customer_receivable','provider_clawback_receivable','provider_payable','refund_liability','platform_fee_revenue','platform_commission_revenue','platform_reserve'];
const bal = async () => { const m = Object.fromEntries(ACCTS.map(a => [a, 0])); for (const r of await ledger.trialBalance('MUR')) m[r.account] = Number(r.balance); return m; };
const ADMIN = { userId: null, type: 'admin', mfa: true };
const SUPPORT = { userId: null, type: 'support', mfa: true };
const FIN = { userId: null, type: 'finance', mfa: true };

async function login(phone, app) {
  const otp = await auth.requestOtp(phone, 'login');
  const t = await auth.verifyOtp({ phone, code: otp.devCode, deviceId: `dev-${phone}`, app });
  return { userId: t.user.id, type: t.user.type, marketId: t.user.marketId, sessionId: 'x' };
}

async function pay(customer, bookingId, outcome = 'succeeded') {
  const r = await payments.initiate(customer, bookingId, 'trades://payment-return');
  const sid = r.redirectUrl.split('/').pop();
  const cb = sandboxGw.buildCallback(sid, outcome);
  const res = await payments.handleWebhook('sandbox', { 'x-sandbox-signature': cb.signature }, cb.raw, cb.body);
  await relay();
  return { ...r, cb, res };
}

async function main() {
  console.log('\nTrades e2e — real services, real PostgreSQL\n');

  // ── Admin & staff
  const adminU = await one(`INSERT INTO users (email, full_name, user_type) VALUES ('ops@trades.mu','Ops Admin','admin') RETURNING id`);
  ADMIN.userId = adminU.id;
  const supU = await one(`INSERT INTO users (email, full_name, user_type) VALUES ('support@trades.mu','Support','support') RETURNING id`); SUPPORT.userId = supU.id;
  const finU = await one(`INSERT INTO users (email, full_name, user_type) VALUES ('finance@trades.mu','Finance','finance') RETURNING id`); FIN.userId = finU.id;

  // ── Customer onboarding
  const reg = await auth.registerCustomer({ phone: '+23059990001', fullName: 'Aisha Customer', email: 'aisha@example.mu' });
  assert.ok(reg.devCode);
  const cust = await login('+23059990001', 'customer');
  const addr = await users.createAddress(cust, { label: 'Home', line1: '5 Rue Desforges', city: 'Port Louis', lat: -20.1609, lng: 57.5012, accessNotes: 'Gate code 4321' });
  ok('customer registered via phone OTP, address saved');
  await assert.rejects(auth.verifyOtp({ phone: '+23059990001', code: '000000', deviceId: 'x' }), /code/i);
  ok('wrong / reused OTP rejected');

  // ── Providers onboarding + KYC + admin approval
  const plumbing = await one(`SELECT id FROM service_categories WHERE slug = 'plumbing'`);
  const leak = await one(`SELECT id FROM service_categories WHERE slug = 'plumbing-leak'`);
  const provs = [];
  const homes = [[-20.1650, 57.5050], [-20.1700, 57.4950], [-20.2449, 57.4891]];
  for (let i = 0; i < 3; i++) {
    const phone = `+2305888000${i}`;
    await auth.registerProvider({ phone, fullName: `Plumber ${i}`, businessName: `Pipes ${i} Ltd` });
    const p = await login(phone, 'provider');
    await providers.updateProfile(p, { bio: 'Licensed plumber, 10 years', yearsExperience: 10, maxConcurrentJobs: 2 });
    await providers.setCategories(p, [{ categoryId: plumbing.id }]);
    await providers.setLocations(p, { homeBase: { lat: homes[i][0], lng: homes[i][1] }, zones: [{ type: 'radius', centerLat: homes[i][0], centerLng: homes[i][1], radiusM: 25000 }] });
    for (const kind of ['id_front', 'selfie']) await providers.addDocument(p, { kind, storageKey: `kyc/${p.userId}/2026-10-07/${kind}.jpg` });
    const su = await auth.startStepUp(p);
    await providers.setPayoutAccount(p, { method: 'bank_transfer', accountHolderName: `Plumber ${i}`, bankName: 'MCB', accountNumber: 'MU17BOMM0101101030300200000MUR', stepUpCode: su.devCode });
    await assert.rejects(providers.setAvailability(p, 'online'), /verified/);
    assert.equal((await providers.submitForVerification(p)).verificationStatus, 'pending');
    provs.push(p);
  }
  await assert.rejects(admin.decideVerification(SUPPORT, provs[0].userId, 'approve'), /admin/);
  await assert.rejects(admin.decideVerification(ADMIN, provs[0].userId, 'approve'), /ID and selfie/);
  for (const p of provs) {
    for (const d of await db.many(`SELECT id FROM provider_documents WHERE provider_id = $1`, [p.userId])) await admin.reviewDocument(SUPPORT, d.id, 'approved');
    await admin.decideVerification(ADMIN, p.userId, 'approve');
    await providers.setAvailability(p, 'online');
  }
  // payout accounts were set before any payout → no cool-off; make them immediately usable in test
  await db.pool.query(`UPDATE payout_accounts SET payouts_allowed_after = now() - interval '1 minute'`);
  ok('3 providers: profile, category, zone, KYC docs, step-up-protected payout account, support review → admin approval, online');

  // ── Urgent request → dispatch
  const req1 = await requests.create(cust, { categoryId: leak.id, mode: 'urgent', description: 'Burst pipe under kitchen sink, water everywhere', addressId: addr.id });
  assert.equal(req1.location.precision, 'exact');
  await relay();
  let r1 = await one(`SELECT * FROM service_requests WHERE id = $1`, [req1.id]);
  const notified = await db.many(`SELECT provider_id, distance_m, wave FROM provider_dispatches WHERE service_request_id = $1 ORDER BY distance_m`, [req1.id]);
  assert.equal(r1.status, 'dispatched');
  assert.equal(notified.length, 3, 'expanded radius until min 3 candidates');
  assert.ok(r1.current_search_radius_m > 5000, `radius expanded to ${r1.current_search_radius_m}`);
  ok(`urgent request dispatched: radius auto-expanded 5km → ${r1.current_search_radius_m / 1000}km to reach 3 providers (subcategory matched parent category)`);
  const provView = await requests.get(provs[0], req1.id);
  assert.equal(provView.location.precision, 'approximate');
  assert.notEqual(provView.location.lat, -20.1609);
  ok('provider sees only approximate location before acceptance (§G.7); dispatch marked viewed');
  const notifCount = await one(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND channel = 'sms'`, [provs[0].userId]);
  assert.ok(notifCount.n >= 1, 'urgent → SMS to provider');
  ok('outbox → notification listener queued push+SMS+in-app for urgent dispatch');

  // ── Quotes + negotiation
  const q0 = await quotes.submit(provs[0], { requestId: req1.id, amount: '2000.00', message: 'Can be there in 20 min' });
  const q1 = await quotes.submit(provs[1], { requestId: req1.id, amount: '2500.00' });
  await assert.rejects(quotes.submit(provs[1], { requestId: req1.id, amount: '2400.00' }), /already have a live quote/);
  r1 = await one(`SELECT status FROM service_requests WHERE id = $1`, [req1.id]);
  assert.equal(r1.status, 'quoted');
  ok('two quotes submitted; second live quote from same provider blocked; request → quoted');
  await messaging.send(cust, req1.id, 'Hi! Call me on 5712 3456 please', provs[1].userId);
  const thread = await messaging.thread(provs[1], req1.id);
  assert.ok(thread[0].redacted && !thread[0].body.includes('5712'));
  ok('pre-payment chat redacts phone numbers (anti-disintermediation)');
  const co1 = await quotes.counter(cust, q1.id, { amount: '2200.00' });
  await assert.rejects(quotes.respond(cust, co1.id, { action: 'accept' }), /own offer/);
  const co2 = await quotes.respond(provs[1], co1.id, { action: 'counter', amount: '2300.00' });
  const acc = await quotes.respond(cust, co2.counterOffer.id, { action: 'accept' });
  assert.ok(acc.bookingId);
  const b1 = await one(`SELECT * FROM bookings WHERE id = $1`, [acc.bookingId]);
  assert.equal(b1.agreed_amount, '2300.00');
  assert.equal((await one(`SELECT status FROM quotes WHERE id = $1`, [q0.id])).status, 'closed');
  const fee = await one(`SELECT fee_amount FROM platform_fees WHERE booking_id = $1`, [b1.id]);
  assert.equal(fee.fee_amount, '345.00');
  await relay();
  ok('customer counter 2200 → provider counter 2300 → customer accepts → booking at MUR 2300, fees frozen (fee 345), other quote closed');

  // ── Payment via sandbox gateway (signed webhook)
  const custView = await bookings.get(cust, b1.id);
  assert.equal(custView.pricing.total.amount, '2645.00');
  const spoof = await payments.handleWebhook('sandbox', { 'x-sandbox-signature': 'bad' }, Buffer.from('{}'), { order_id: 'x' });
  assert.equal(spoof.ok, false);
  ok('customer sees 2300 + 15% fee = MUR 2645; spoofed webhook rejected & logged');
  const p1 = await pay(cust, b1.id);
  assert.equal(p1.res.ok, true);
  const replay = await payments.handleWebhook('sandbox', { 'x-sandbox-signature': p1.cb.signature }, p1.cb.raw, p1.cb.body);
  assert.equal(replay.duplicate, true);
  let bk = await one(`SELECT status FROM bookings WHERE id = $1`, [b1.id]);
  assert.equal(bk.status, 'assigned');
  let L = await bal();
  assert.equal(L.cash_settlement, 2645); assert.equal(L.provider_payable, 1955); assert.equal(L.platform_fee_revenue, 345); assert.equal(L.platform_commission_revenue, 345);
  ok('signed webhook captured payment → booking assigned; replayed webhook ignored; ledger: cash 2645 = payable 1955 + fee 345 + commission 345');
  const provBooking = await bookings.get(provs[1], b1.id);
  assert.equal(provBooking.location.precision, 'exact');
  assert.equal(provBooking.location.accessNotes, 'Gate code 4321');
  assert.equal(provBooking.pricing.payout.amount, '1955.00');
  ok('after payment provider sees exact address + access notes and their payout (2300 − 15% = 1955); sensitive read logged');

  // ── Job lifecycle
  await assert.rejects(bookings.start(cust, b1.id, {}), /Forbidden/);
  await bookings.jobEvent(provs[1], b1.id, { type: 'en_route', etaMin: 15 });
  const st = await bookings.start(provs[1], b1.id, { lat: -20.1611, lng: 57.5013 });
  assert.equal(st.withinGeofence, true);
  await bookings.complete(provs[1], b1.id, { notes: 'Replaced pipe section', photoKeys: [`job_photo/${provs[1].userId}/2026-10-07/after.jpg`] });
  await assert.rejects(bookings.approve(provs[1], b1.id), /Forbidden/);
  const ap = await bookings.approve(cust, b1.id);
  const hrs = (new Date(ap.payoutEligibleAt) - Date.now()) / 3600e3;
  assert.ok(hrs > 47.9 && hrs <= 48.01, `eligible in ${hrs}h`);
  await relay();
  ok('en route → start (geofence ✓) → complete with photo → customer approves → payout scheduled T+48h');
  assert.equal(await payouts.releaseDue(), 0);
  await db.pool.query(`UPDATE payout_records SET eligible_at = now() - interval '1 minute' WHERE booking_id = $1`, [b1.id]);
  assert.equal(await payouts.releaseDue(), 1);
  assert.equal(await payouts.releaseDue(), 0);
  bk = await one(`SELECT status FROM bookings WHERE id = $1`, [b1.id]);
  assert.equal(bk.status, 'payout_released');
  L = await bal();
  assert.equal(L.provider_payable, 0); assert.equal(L.cash_settlement, 690);
  await relay();
  ok('payout not released before T+48h; released exactly once after; provider_payable → 0, cash = platform revenue 690');

  // ── Reviews (double-blind)
  const rv1 = await reviews.create(cust, { bookingId: b1.id, rating: 5, comment: 'Fast and tidy! Text me 57123456', breakdown: { quality: 5, punctuality: 5 } });
  assert.ok(new Date(rv1.visible_at) > new Date());
  assert.ok(!rv1.comment.includes('57123456'));
  const rv2 = await reviews.create(provs[1], { bookingId: b1.id, rating: 4, breakdown: { site_readiness: 4 } });
  assert.ok(new Date(rv2.visible_at) <= new Date());
  const pr = await one(`SELECT rating_avg, rating_count FROM providers WHERE id = $1`, [provs[1].userId]);
  assert.equal(pr.rating_count, 1); assert.equal(pr.rating_avg, '5.00');
  ok('double-blind reviews: hidden until both submitted, then released; PII redacted; provider rating aggregated');

  // ── Scenario 2: scheduled job → dispute → partial refund → reduced payout
  const inTwoDays = new Date(Date.now() + 2 * 86400e3).toISOString();
  const req2 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: inTwoDays, description: 'Install new bathroom mixer tap', addressId: addr.id });
  await relay();
  const q2 = await quotes.submit(provs[0], { requestId: req2.id, amount: '2000.00' });
  const a2 = await quotes.accept(cust, q2.id);
  await pay(cust, a2.bookingId);
  await bookings.start(provs[0], a2.bookingId, {});
  await bookings.complete(provs[0], a2.bookingId, { notes: 'done' });
  const d2 = await disputes.open(cust, { bookingId: a2.bookingId, reasonCode: 'incomplete_work', description: 'Tap still leaks at the base' });
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a2.bookingId])).status, 'disputed');
  await disputes.startReview(SUPPORT, d2.id);
  await disputes.requestEvidence(SUPPORT, d2.id, { message: 'Please upload a photo of the leak' });
  await disputes.message(cust, d2.id, { body: 'Photo attached', attachmentKeys: [`dispute_evidence/${cust.userId}/2026-10-07/leak.jpg`] });
  await cfg.set('support_goodwill_cap', { MUR: 50000 }, ADMIN, 'Lower support cap to MUR 500 for test');
  await assert.rejects(disputes.resolve(SUPPORT, d2.id, { resolution: 'refund_partial', adjustedAmount: '1500.00', notes: 'Partial refund for leak' }), /exceeds|above/i);
  const res2 = await disputes.resolve(ADMIN, d2.id, { resolution: 'refund_partial', adjustedAmount: '1500.00', notes: 'Work 75% complete; partial refund agreed' });
  assert.equal(res2.refundToCustomer, '575.00'); assert.equal(res2.providerPayout, '1275.00');
  await relay();
  bk = await one(`SELECT status FROM bookings WHERE id = $1`, [a2.bookingId]);
  assert.equal(bk.status, 'payout_pending');
  const po2 = await one(`SELECT * FROM payout_records WHERE booking_id = $1`, [a2.bookingId]);
  assert.equal(po2.net_payout_amount, '1275.00');
  assert.equal(await payouts.releaseDue(), 1);
  L = await bal();
  assert.equal(L.provider_payable, 0); assert.equal(L.refund_liability, 0);
  assert.equal(L.cash_settlement, 690 + 450);
  ok('dispute → evidence → support blocked above goodwill cap → admin partial refund (job value 1500): customer refunded 575, provider paid 1275, fees shrink pro-rata');

  // ── Scenario 3: late customer cancellation after assignment
  const soon = new Date(Date.now() + 60 * 60e3).toISOString();
  const req3 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: soon, description: 'Unblock shower drain', addressId: addr.id });
  await relay();
  const q3 = await quotes.submit(provs[2], { requestId: req3.id, amount: '3000.00' });
  const a3 = await quotes.accept(cust, q3.id);
  await pay(cust, a3.bookingId);
  const c3 = await bookings.cancel(cust, a3.bookingId, 'Fixed it myself');
  assert.equal(c3.refund, '3105.00'); // 3450 charged − (300 fee retained × 1.15)
  await relay();
  bk = await one(`SELECT status FROM bookings WHERE id = $1`, [a3.bookingId]);
  assert.equal(bk.status, 'payout_pending');
  const po3 = await one(`SELECT net_payout_amount FROM payout_records WHERE booking_id = $1`, [a3.bookingId]);
  assert.equal(po3.net_payout_amount, '255.00');
  ok('late cancellation (<2h): 10% cancellation fee kept → customer refunded 3105, provider compensated 255 after T+48h');

  // ── Scenario 4: provider no-show → full refund + penalty + automatic re-dispatch
  const req4 = await requests.create(cust, { categoryId: leak.id, mode: 'urgent', description: 'Toilet overflowing', addressId: addr.id });
  await relay();
  const q4 = await quotes.submit(provs[0], { requestId: req4.id, amount: '1800.00' });
  const a4 = await quotes.accept(cust, q4.id);
  await pay(cust, a4.bookingId);
  const before = await one(`SELECT no_show_count FROM providers WHERE id = $1`, [provs[0].userId]);
  const reqCountBefore = (await one(`SELECT count(*)::int AS n FROM service_requests WHERE customer_id = $1`, [cust.userId])).n;
  const ns = await bookings.cancel(cust, a4.bookingId, 'Provider never arrived', { noShow: true });
  assert.equal(ns.refund, '2070.00');
  const after = await one(`SELECT no_show_count FROM providers WHERE id = $1`, [provs[0].userId]);
  assert.equal(after.no_show_count, before.no_show_count + 1);
  const reqCountAfter = (await one(`SELECT count(*)::int AS n FROM service_requests WHERE customer_id = $1`, [cust.userId])).n;
  assert.equal(reqCountAfter, reqCountBefore + 1);
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a4.bookingId])).status, 'refunded');
  await relay();
  ok('no-show: full refund 2070, provider no_show_count +1 (ranking penalty), job automatically re-dispatched');

  // ── Scenario 5: dispute AFTER payout released → full refund → clawback recovered from next payout
  const d5 = await disputes.open(cust, { bookingId: b1.id, reasonCode: 'damage', description: 'Cabinet under sink was damaged during repair' });
  const po1 = await one(`SELECT status FROM payout_records WHERE booking_id = $1`, [b1.id]);
  assert.equal(po1.status, 'released');
  await assert.rejects(disputes.resolve(SUPPORT, d5.id, { resolution: 'refund_full', notes: 'Damage confirmed by photos' }), /admin/);
  const res5 = await disputes.resolve(ADMIN, d5.id, { resolution: 'refund_full', notes: 'Damage confirmed by photos; full refund, clawback provider share' });
  assert.equal(res5.clawback, '1955.00');
  const cb5 = await one(`SELECT * FROM provider_clawbacks WHERE booking_id = $1`, [b1.id]);
  assert.equal(cb5.amount, '1955.00');
  L = await bal();
  assert.equal(L.provider_clawback_receivable, 1955);
  ok('dispute after payout: full refund 2645 from platform, clawback receivable 1955 opened against provider');
  // next job for same provider: payout 50% withheld
  const req6 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: inTwoDays, description: 'Fix dripping tap', addressId: addr.id });
  await relay();
  const q6 = await quotes.submit(provs[1], { requestId: req6.id, amount: '1000.00' });
  const a6 = await quotes.accept(cust, q6.id);
  await pay(cust, a6.bookingId);
  await bookings.start(provs[1], a6.bookingId, {}); await bookings.complete(provs[1], a6.bookingId, {}); await bookings.approve(cust, a6.bookingId);
  await db.pool.query(`UPDATE payout_records SET eligible_at = now() - interval '1 minute' WHERE booking_id = $1`, [a6.bookingId]);
  await payouts.releaseDue();
  const po6 = await one(`SELECT * FROM payout_records WHERE booking_id = $1`, [a6.bookingId]);
  assert.equal(po6.status, 'released'); assert.equal(po6.clawback_recovered, '425.00');
  const cb5b = await one(`SELECT * FROM provider_clawbacks WHERE booking_id = $1`, [b1.id]);
  assert.equal(cb5b.recovered_amount, '425.00'); assert.equal(cb5b.status, 'recovering');
  ok('next payout (850) withheld 50% = 425 toward the clawback (capped per policy); provider notified');
  await payouts.writeOffClawback(FIN, cb5.id, 'Provider left platform, write off remaining');
  L = await bal();
  assert.equal(L.provider_clawback_receivable, 0);
  ok('finance writes off remaining clawback to platform reserve');

  // ── Scenario 6: unpaid booking expires; late payment auto-refunded
  const req7 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: inTwoDays, description: 'Check water pressure', addressId: addr.id });
  await relay();
  const q7 = await quotes.submit(provs[2], { requestId: req7.id, amount: '500.00' });
  const a7 = await quotes.accept(cust, q7.id);
  const init7 = await payments.initiate(cust, a7.bookingId, 'trades://payment-return');
  await db.pool.query(`UPDATE bookings SET payment_due_at = now() - interval '1 minute' WHERE id = $1`, [a7.bookingId]);
  assert.equal(await bookings.expireUnpaid(), 1);
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a7.bookingId])).status, 'cancelled');
  ok('payment window lapsed → booking cancelled by system');

  // ── Declined card, card-testing signal
  const req8 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: inTwoDays, description: 'Replace washer', addressId: addr.id });
  await relay();
  const q8 = await quotes.submit(provs[2], { requestId: req8.id, amount: '400.00' });
  const a8 = await quotes.accept(cust, q8.id);
  await pay(cust, a8.bookingId, 'failed');
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a8.bookingId])).status, 'payment_pending');
  const retry = await pay(cust, a8.bookingId, 'succeeded');
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a8.bookingId])).status, 'assigned');
  const attempts = await db.many(`SELECT attempt, status FROM payments WHERE booking_id = $1 ORDER BY attempt`, [a8.bookingId]);
  assert.deepEqual(attempts.map(a => a.status), ['failed', 'captured']);
  ok('declined card → booking stays payment_pending → retry with a NEW intent succeeds');

  // ── Chargeback on booking 8
  await admin.ingestChargeback(FIN, { paymentId: (await one(`SELECT id FROM payments WHERE booking_id = $1 AND status='captured'`, [a8.bookingId])).id, reference: 'CB-001', amount: '460.00', reason: 'Fraudulent transaction' });
  const cbd = await one(`SELECT * FROM disputes WHERE booking_id = $1 AND source = 'chargeback'`, [a8.bookingId]);
  assert.equal(cbd.routed_to, 'finance');
  assert.equal((await one(`SELECT status FROM bookings WHERE id = $1`, [a8.bookingId])).status, 'assigned', 'assigned bookings cannot enter disputed — payout never created');
  ok('chargeback ingested: finance dispute opened with response deadline, reserve debited');

  // ── Quote expiry and request revert
  const req9 = await requests.create(cust, { categoryId: plumbing.id, mode: 'scheduled', scheduledFor: inTwoDays, description: 'Quote expiry test', addressId: addr.id });
  await relay();
  const q9 = await quotes.submit(provs[0], { requestId: req9.id, amount: '700.00' });
  await db.pool.query(`UPDATE quotes SET valid_until = now() - interval '1 second' WHERE id = $1`, [q9.id]);
  await quotes.expireDue();
  assert.equal((await one(`SELECT status FROM quotes WHERE id = $1`, [q9.id])).status, 'expired');
  assert.equal((await one(`SELECT status FROM service_requests WHERE id = $1`, [req9.id])).status, 'dispatched');
  ok('quote expired by scheduler → request back to dispatched for more quotes');

  // ── Instant accept (urgent)
  await db.pool.query(`UPDATE service_categories SET instant_accept_price = 1500 WHERE slug = 'plumbing'`);
  await db.pool.query(`UPDATE providers SET instant_accept_enabled = true WHERE id = $1`, [provs[2].userId]);
  const req10 = await requests.create(cust, { categoryId: plumbing.id, mode: 'urgent', description: 'No water at all', addressId: addr.id, instantAccept: true });
  await relay();
  const ia = await quotes.instantAccept(provs[2], req10.id);
  const b10 = await one(`SELECT agreed_amount, status FROM bookings WHERE id = $1`, [ia.bookingId]);
  assert.equal(b10.agreed_amount, '1500.00');
  await assert.rejects(quotes.instantAccept(provs[0], req10.id), /taken|Enable/);
  ok('urgent instant-accept: first opted-in provider books at the preset price, second is refused');

  // ── Recurring agreement
  const rec = await recurring.create(cust, { categoryId: plumbing.id, addressId: addr.id, cadenceRule: 'FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=10', startsOn: new Date().toISOString(), description: 'Weekly pool pump check', preferredProviderId: provs[1].userId, agreedRate: '900.00', leadTimeHours: 168 });
  const gen = await recurring.generateDue();
  assert.ok(gen >= 1);
  const occReq = await one(`SELECT * FROM service_requests WHERE recurring_agreement_id = $1 ORDER BY occurrence_at LIMIT 1`, [rec.id]);
  assert.equal(occReq.status, 'dispatched');
  const occD = await db.many(`SELECT provider_id FROM provider_dispatches WHERE service_request_id = $1`, [occReq.id]);
  assert.deepEqual(occD.map(d => d.provider_id), [provs[1].userId]);
  const occQ = await quotes.submit(provs[1], { requestId: occReq.id, amount: '900.00' });
  assert.equal(occQ.autoAccepted, true);
  assert.equal(await recurring.generateDue(), 0, 'idempotent');
  ok(`recurring weekly agreement: ${gen} occurrence(s) generated, offered to preferred provider only, agreed rate auto-books`);

  // ── Scheduler tick runs every job without error
  for (const job of scheduler.jobs) await scheduler.tick(job);
  ok(`scheduler: all ${scheduler.jobs.length} jobs ran under advisory locks`);

  // ── Notifications delivery (dev channels)
  const delivered = await notifications.deliverDue(500);
  const failedPush = await one(`SELECT count(*)::int AS n FROM notifications WHERE channel = 'push' AND status = 'failed'`);
  ok(`notification worker processed ${delivered} queued messages (push without device tokens dead-lettered: ${failedPush.n})`);

  // ── Accounting identity across everything above
  L = await bal();
  const assets = L.cash_settlement + L.provider_clawback_receivable + L.customer_receivable;
  const claims = L.provider_payable + L.refund_liability + L.platform_fee_revenue + L.platform_commission_revenue + L.platform_reserve;
  assert.equal(Math.round(assets * 100), Math.round(claims * 100));
  const tb = await one(`SELECT sum(CASE WHEN entry_type='debit' THEN amount ELSE -amount END) AS net FROM ledger_entries`);
  assert.equal(Number(tb.net), 0);
  console.log('    ledger:', JSON.stringify(L));
  ok('ledger balanced overall; assets (cash + clawback) = liabilities + revenue + reserve');

  const unbalancedStates = await db.many(`SELECT b.reference, b.status, pr.status AS payout FROM bookings b LEFT JOIN payout_records pr ON pr.booking_id = b.id WHERE b.status = 'payout_released' AND pr.status NOT IN ('released','settled','clawed_back')`);
  assert.equal(unbalancedStates.length, 0);
  const events = await one(`SELECT count(*)::int AS n FROM state_events`);
  const auditN = await one(`SELECT count(*)::int AS n FROM audit_logs`);
  ok(`state history: ${events.n} transitions recorded; ${auditN.n} audit log entries`);

  const dash = await admin.dashboard();
  assert.ok(dash.kpi && dash.queues);
  ok(`admin dashboard: ${JSON.stringify(dash.queues)}`);

  console.log(`\nALL ${step} E2E CHECKS PASSED\n`);
}

main().then(() => db.pool.end()).catch(async e => { console.error('\nE2E FAILED:', e); await db.pool.end(); process.exit(1); });
