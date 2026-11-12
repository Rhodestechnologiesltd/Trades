# Deployment & release

## Backend
- Build the image from `backend/Dockerfile`. Run it as two deployments from the same image: `api` (`node dist/src/main.js`, horizontally scalable) and `worker` (`node dist/src/worker.js`; scalable, because jobs take advisory locks). Set `OUTBOX_RELAY=false` on the worker so outbox events are relayed inside the API processes that hold the WebSocket connections. With several API replicas, add the socket.io Redis adapter.
- Use managed PostgreSQL 16 with PostGIS 3, multi-AZ, PITR backups. Run migrations as a pre-deploy job with `node dist/src/scripts/migrate.js`.
- Redis provides rate limits. S3 needs SSE plus lifecycle rules: purge KYC documents after account closure plus the legal retention period.
- `NODE_ENV=production` refuses to start with dev secrets, a sandbox gateway or OTP echo turned on (`assertProductionConfig`).
- Set alerts on the dashboard queue counters: disputes past SLA, payouts stuck in processing, rejected webhooks, dead-lettered notifications. Wire OpenTelemetry/APM exporters per §M.

## MIPS go-live checklist
1. Obtain merchant credentials (`MIPS_MERCHANT_ID`, `ENTITY_ID`, `OPERATOR_ID/PASSWORD`, API user, IMN salt/cipher key).
2. Confirm the endpoint names and IMN fields in `mips.gateway.ts`, plus refund and status APIs and the refund window.
3. Register the IMN URL `https://<api>/v1/payments/mips/callback` and the return URL `https://<api>/v1/payments/return`.
4. Run a live MUR 10 transaction end to end, then a refund, and check the reconciliation run in the dashboard (Ledger → Reconcile) against the settlement report.

## Mobile apps (EAS)
```bash
npm i -g eas-cli && eas login
cd apps/customer && eas init      # writes the projectId; set extra.eas.projectId + Maps keys in app.json
eas build -p ios --profile production && eas build -p android --profile production
eas submit -p ios && eas submit -p android
```
- Push: upload your APNs key and FCM credentials to EAS (`eas credentials`) and set `EXPO_ACCESS_TOKEN` on the API.
- **Provider app background location:** Apple and Google both review "always" location access. Use the permission copy already in `app.json`, add the Play Console background-location declaration with a video of going online, and keep the foreground-service notification.
- Store listings need a privacy policy URL and data-safety answers covering location, photos, phone number and payment (processed by MIPS).

## Web
- `apps/web`: `next build && next start` (or Vercel) with `NEXT_PUBLIC_API_URL`. Landing and service pages use ISR (10-minute revalidate).
- `apps/admin`: `vite build`, then host behind your SSO/VPN on an internal domain. It is a staff-only tool and requires staff MFA.
