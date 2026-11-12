# Architecture & spec traceability

This maps each section of the *Production Technical Specification v1.0* to the code, then lists the design decisions taken where the spec left room, and the deliberate deviations.

## 1. System shape (§B)

The backend is a **NestJS modular monolith**. Each module maps 1:1 to a service in §B.1, and modules talk only through service interfaces and the transactional outbox. Any module can therefore be lifted into its own deployable later (for example, Dispatch in Go, §M) without changing its callers. The API and the background worker use the same image: `main.js` serves HTTP and WebSockets, and `worker.js` runs the scheduler.

| Spec service | Module | Notes |
|---|---|---|
| API Gateway / BFF | `main.ts`, `common/auth.ts`, `common/idempotency.interceptor.ts` | JWT auth, RBAC guard, rate limits, idempotency, Helmet, request IDs |
| Auth Service | `modules/auth` | Phone OTP, refresh-token rotation with reuse detection, device tracking, staff password + TOTP MFA, step-up OTP |
| Booking/Request Service | `modules/requests`, `modules/quotes`, `modules/bookings`, `modules/recurring`, `modules/messaging` | State machines from `packages/domain/lifecycles.ts` |
| Geolocation & Dispatch | `modules/dispatch` + SQL `find_dispatch_candidates()` | Hard filters in SQL (§G.6); ranking, waves and expansion in the domain package |
| Payment/Ledger | `modules/payments`, `modules/ledger`, `modules/payouts` | Payment Provider Interface (`gateway.ts`) with MIPS + sandbox adapters; disbursement rail interface |
| Notification Service | `modules/notifications` | Outbox listener → push (Expo → FCM/APNs), SMS (Twilio), email (SendGrid), in-app feed; retry/backoff/dead-letter |
| Reviews/Dispute | `modules/reviews`, `modules/disputes` | Double-blind release, moderation; structured reasons, SLA, routing, settlement |
| Background scheduler | `modules/scheduler` | 15 idempotent sweeps under Postgres advisory locks |
| Media storage | `modules/media` | Presigned S3 PUT/GET only, owner-namespaced keys, SSE |
| Admin dashboard | `modules/admin` + `apps/admin` | RBAC per §I; every mutation audit-logged with a reason |
| Event bus | `common/outbox.service.ts` | Transactional outbox → in-process bus + Kafka when `KAFKA_BROKERS` is set |
| Realtime | `modules/realtime` | socket.io on `/realtime`; per-user and per-booking rooms; invalidation-only payloads |

## 2. State machines (§C)

All lifecycles live in `packages/domain/src/lifecycles.ts` as explicit transition tables, each saying which actors may fire which trigger. `StateService.transition()` locks the row, validates the trigger, updates `status` and appends to `state_events` in the same transaction, which gives the event-sourced history the spec asks for. Unit tests prove every booking and request state is reachable and that clients cannot fire system-only triggers (for example `payment_captured`).

## 3. Data model (§D)

`backend/migrations/001_init.sql` implements every table in §D, plus the tables the flows need: OTP challenges, sessions, devices, push tokens, provider documents, location pings, availability windows, time off, journal headers, webhook events, refunds, clawbacks, payout batches, settlement reports, reconciliation runs, dispute messages, booking messages, outbox, idempotency keys, sensitive-access log and fraud signals.

Integrity is enforced by the database, not only by application code (tested in `backend/test/sql/safety_tests.sql`):

- One payout per booking (`UNIQUE booking_id`) and at most one live captured payment per booking.
- One live quote per provider per request, and one accepted quote per request.
- Counter-offers are immutable, and their round numbers are unique per quote.
- Ledger entries, journals, audit logs, state events and frozen fee rows are append-only (statement-level triggers).
- Every ledger journal must balance at COMMIT (deferred constraint trigger).
- `net_payout = gross − commission`, enforced by a CHECK constraint.

## 4. Money (§F)

- **Fees** (`domain/fees.ts`): integer minor units with half-up rounding. Invariants are asserted on every booking: `charge = agreed + fee`, `net = agreed − commission`, `charge = net + platform gross`. They are frozen into `platform_fees` and `platform_commissions` when the booking is created.
- **Hold model:** MIPS captures directly to the platform account. The provider's share sits in `provider_payable` (plus `payment_holds`) until the T+48h payout. This is the "virtual hold" from §0.
- **Ledger postings** (`domain/ledger.ts`) are built by pure functions that balance by construction. *Deviation:* the example postings in §F.3 do not balance as written. The implementation is the balanced equivalent of their intent: revenue is recognised at capture, and the provider share is a liability until it is paid.
- **Settlements** (cancellations and disputes) are expressed as an *adjusted job value*. Fees and commission are recomputed on it, so refunds shrink the platform fee pro-rata and the books always balance. See `computeSettlement()`.
- **Double-payout prevention (§F.4):** `claim_due_payouts()` uses `FOR UPDATE SKIP LOCKED` and moves rows to `processing` in a single statement. The rail is called only after commit, with the payout's idempotency key. Rows stuck in `processing` are reconciled by looking up that key, never by sending again. A concurrency test races two workers.
- **Refunds, clawbacks and chargebacks (§F.5):** gateway refunds retry automatically. If the gateway says it cannot refund, Finance pays by bank transfer from reserve. A refund after payout opens a clawback receivable, recovered from future payouts at no more than 50% per payout; Finance can write off the rest. Chargebacks freeze the payout, open a finance dispute with the response deadline, debit the reserve and page all finance operators.
- **Webhooks:** authenticated (HMAC for the sandbox; MIPS IMN decrypted with merchant keys), deduplicated by `(gateway, event_id)`, and checked for amount and currency mismatches. Spoofed callbacks are stored, never acted on, and counted on the dashboard.

## 5. Dispatch (§G)

- **Hard filters** are in SQL: market, verified, active, not fraud-flagged, has capacity, category (or the parent of a requested subcategory), licence approved for licence-gated categories, background check for childcare, provider's own zone contains the job, within the search radius, and not on time off.
- **Ranking** uses Bayesian-smoothed ratings plus distance, workload, response-speed EMA, urgent reliability and quote conversion, with a penalty per no-show. Weights are set per mode and can be overridden by admins.
- **Staggered waves.** Radius expansion ×1.5 runs until the minimum candidate count is reached, up to the market or mode maximum. If nobody is reachable, the request expires and is flagged for admin assist when urgent. Urgent requests jump the sweep queue and only reach online providers. Scheduled jobs also notify offline providers by push, and are dispatched up to 72 hours before the slot.
- **Instant-accept** for urgent requests (§G.4): first come, first served, at the category's call-out price.
- **Privacy (§G.7):** providers see a deterministic grid-snapped location (~400 m) until payment, then the exact address and access notes, and that read is logged. Live tracking is shown only while a booking is `assigned` or `in_progress`. Raw pings are purged after 30 days.
- **Spoofing (§J):** OS mock-location flag, implied-speed check (200 km/h with accuracy tolerance), and geofence checks at start and completion. Each of these raises a fraud signal.

## 6. Security (§J)

- Short-lived JWTs (15 minutes) with rotating refresh tokens. Reusing a rotated token revokes the whole token family.
- Staff accounts require password + TOTP and are never self-registered.
- RBAC is checked in the guard and resource ownership is re-checked in each service.
- PII is encrypted with AES-256-GCM (payout details, MFA secrets).
- Changing a payout account needs a step-up OTP, then a 24-hour cooling-off period during which payouts to the new account are held.
- Card data never touches the platform: hosted MIPS page, PCI SAQ-A scope.
- Rate limits cover OTP, quotes, urgent requests, payment attempts and messages.
- Fraud signals: quote spam, card testing, collusion, fake completion, chargeback rate, location jumps, payout-account changes.
- Pre-payment chat redacts phone numbers, emails and links.

## 7. Decisions taken where the spec was open

| Topic | Decision |
|---|---|
| Scheduler | Durable state lives in table columns (`eligible_at`, `valid_until`, `auto_approve_at`, `next_dispatch_check_at`, …), swept by idempotent jobs under advisory locks. Temporal remains the upgrade path (§M) if workflows need more visibility. |
| Negotiation | Default is 3 rounds, alternating, and only the receiving party can respond. If the provider rejects the customer's counter, negotiation ends and the provider's last offer stands as the final offer. |
| Disputes on `assigned` | Handled through the no-show flow (full refund, provider penalty, automatic re-dispatch) rather than a dispute. |
| Late cancellation | Free until 2 hours before the start time. After that, 10% of the agreed price (minimum Rs 200) goes to the provider. Configurable. |
| Auto-approve | 48 hours after completion, with a reminder 6 hours before. Configurable. |
| Push | Sent through the Expo push service, which delivers via FCM and APNs. It can be replaced by direct FCM/APNs behind the same channel class. |
| Web auth | localStorage tokens for the SPA flow. For hardening, put a same-site BFF with httpOnly cookies in front of the API. |
| Admin UI | Plain CSS instead of AntD/MUI, to keep the internal tool dependency-light. |
| Recurring | RRULE subset (daily, weekly, monthly; interval; BYDAY; BYMONTHDAY; COUNT; UNTIL), evaluated in market wall-clock time. The first booking sets the preferred provider and rate, and later occurrences are offered to that provider first. |

## 8. Phase 2 (§L) — not built, structure ready

AI ranking (weights are already config-driven), live re-ranking, subscriptions and loyalty (`customers.loyalty_points`), route optimisation, provider organisations (`providers.organization_id`), more markets and currencies (everything carries `market_id` and `currency_code`), other gateways (new `PaymentGateway` adapters), and surge pricing for instant-accept. Polygon service zones are supported by the API and dispatch SQL; the provider app's UI offers radius zones only.
