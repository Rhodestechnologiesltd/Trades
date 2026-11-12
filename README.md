# Trades — two-sided on-demand services marketplace

Customers book verified tradespeople (electricians, plumbers, nannies, cleaners, mechanics, tyre repair, handymen, AC repair, painters, gardeners, appliance repair, delivery helpers, …). Launch market is **Mauritius (MUR, MIPS payments)**, and the code is multi-market and multi-currency from the start.

| App | Path | Stack |
|---|---|---|
| Customer app (iOS + Android) | `apps/customer` | Expo SDK 52 / React Native, Expo Router |
| Provider app "Trades Pro" (iOS + Android) | `apps/provider` | Expo SDK 52 / React Native, background location |
| Customer web app + light provider portal | `apps/web` | Next.js 15 (SSR/ISR landing pages for SEO) |
| Ops dashboard (admin / support / finance) | `apps/admin` | React 19 + Vite |
| API + background worker | `backend` | NestJS, PostgreSQL 16 + PostGIS, Redis |
| Domain logic (money, fees, ledger, state machines, dispatch) | `packages/domain` | Pure TypeScript, no dependencies |
| Typed API client + DTOs | `packages/shared` | TypeScript |
| Mobile design system + session/push/realtime | `packages/mobile-ui` | React Native |

## Quick start (local)

```bash
npm install
docker compose up -d db redis                # PostGIS + Redis (S3 storage is optional)
cp backend/.env.example backend/.env          # dev defaults: sandbox payments, OTP echoed in API responses
npm run build -w @trades/domain && npm run build -w @trades/backend
npm run migrate -w @trades/backend            # schema + launch categories + config
npm run seed -w @trades/backend               # demo customer +23059000001 and 6 verified providers
STAFF_PASSWORD='choose-a-long-password' npm run create-staff -w @trades/backend -- you@company.mu admin "Your Name"
                                              # prints a TOTP URI → add it to an authenticator app
npm run dev:api                               # API on :3000, Swagger at /docs
WORKER=true node backend/dist/src/worker.js   # scheduler: dispatch waves, T+48h payouts, expiries…
npm run dev:admin                             # ops dashboard on :5173
npm run dev:web                               # customer web on :3001
EXPO_PUBLIC_API_URL=http://<your-LAN-ip>:3000 npm run dev:customer   # scan the QR code with Expo Go / dev client
EXPO_PUBLIC_API_URL=http://<your-LAN-ip>:3000 npm run dev:provider
```

Or run everything except the mobile apps with `docker compose up`.

In development, `OTP_DEV_ECHO=true` returns the SMS code in the API response and the apps pre-fill it. `PAYMENT_GATEWAY=sandbox` serves a test card page that sends **signed** callbacks, so the full webhook → capture → ledger path runs without real money.

## Tests

```bash
npm run test:domain                  # 31 unit tests: fee math (incl. 50k-amount invariant sweep), ledger, state machines, dispatch ranking, negotiation, recurrence, moderation
npm run test:sql                     # 27 database safety checks incl. a real two-worker race on payout claiming
npm run test:e2e -w @trades/backend  # 32-step end-to-end run of the real services against PostgreSQL
```

The end-to-end suite covers onboarding and KYC approval, urgent dispatch with radius expansion, quotes and counter-offers, signed and spoofed webhooks, payment capture and ledger postings, the job lifecycle, T+48h payout released exactly once, double-blind reviews, a partial-refund dispute, late cancellation, a no-show with automatic re-dispatch, a dispute after payout with a clawback and write-off, an unpaid-booking expiry, a declined card then retry, a chargeback, quote expiry, urgent instant-accept and a recurring agreement. It also checks that every scheduler job runs and that the ledger's accounting identity holds at the end.

## Fee model (spec §F.2) — confirm before go-live

Customer pays **agreed + 15%** and the provider receives **agreed − 15%**, so the platform takes **30%** of job value. Both rates are admin configuration (`platform_config.fees`) with per-market and per-category overrides. They are **frozen onto each booking** when it is created. The ops dashboard warns when the combined take is above 20%, because it is high next to typical marketplaces.

## Before go-live: decisions and integrations we need from you

1. **MIPS integration pack.** The adapter (`backend/src/modules/payments/mips.gateway.ts`) follows the MIPS payment-zone → encrypted IMN → server-side decrypt pattern. You still need to confirm the exact endpoints and field names, refund-API support and window, and status-query support against the documents MIPS issues at merchant onboarding. These details are isolated in that one file plus env vars.
2. **Fee model.** Confirm the 15% + 15% model above.
3. **Cancellation policy defaults.** Free cancellation until 2 hours before the start time. After that a 10% fee applies (minimum Rs 200), and it goes to the provider. This is set in `platform_config.cancellation`.
4. **Accounts and keys:** Apple and Google developer accounts, EAS project IDs, Google Maps keys (in `app.json`), Twilio (or a local SMS aggregator), SendGrid, S3 bucket (with SSE and lifecycle rules), Expo push access token.
5. **KYC vendor.** At launch an admin reviews documents manually (spec §K allows this). Automated ID and liveness checks (Onfido/Veriff-class) plug into the provider verification flow.
6. **Legal and compliance.** Terms, privacy notice (Mauritius Data Protection Act 2017), and confirmation that holding customer funds before payout fits your licensing position. This is not legal advice; please take advice from a local lawyer.

See `docs/ARCHITECTURE.md` for how each spec section maps to code and for the design decisions, and `docs/DEPLOYMENT.md` for store builds and production setup.
