-- SQL-level safety tests: these properties must hold no matter what the
-- application code does (§F.4 double-payout, append-only ledger, §G.6 hard filters).
\set QUIET on
\pset tuples_only on
\pset format unaligned
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(sql TEXT, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS  %  (rejected: %)', label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % — statement unexpectedly succeeded', label;
END $$;

-- ─────────────── fixtures ───────────────
INSERT INTO users (id, phone_number, full_name, user_type, market_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '+23050000001', 'Cust One', 'customer', '00000000-0000-0000-0000-00000000a001');
INSERT INTO customers (id) VALUES ('10000000-0000-0000-0000-000000000001');

-- Providers around Port Louis (-20.1609, 57.5012)
INSERT INTO users (id, phone_number, full_name, user_type, market_id) VALUES
  ('20000000-0000-0000-0000-000000000001', '+23051000001', 'Near Plumber',        'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000002', '+23051000002', 'Far Plumber',         'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000003', '+23051000003', 'Unverified Plumber',  'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000004', '+23051000004', 'Offline Plumber',     'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000005', '+23051000005', 'Busy Plumber',        'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000006', '+23051000006', 'Near Electrician',    'provider', '00000000-0000-0000-0000-00000000a001'),
  ('20000000-0000-0000-0000-000000000007', '+23051000007', 'Zone-excluded Plumber','provider','00000000-0000-0000-0000-00000000a001');
INSERT INTO providers (id, home_base_lat, home_base_lng, verification_status, availability_status, current_active_jobs, max_concurrent_jobs, rating_avg, rating_count) VALUES
  ('20000000-0000-0000-0000-000000000001', -20.1650, 57.5050, 'verified',   'online',  0, 1, 4.8, 40),
  ('20000000-0000-0000-0000-000000000002', -20.3163, 57.5259, 'verified',   'online',  0, 1, 4.9, 90),   -- Curepipe, ~17 km
  ('20000000-0000-0000-0000-000000000003', -20.1620, 57.5020, 'pending',    'online',  0, 1, NULL, 0),
  ('20000000-0000-0000-0000-000000000004', -20.1620, 57.5020, 'verified',   'offline', 0, 1, 4.0, 3),
  ('20000000-0000-0000-0000-000000000005', -20.1620, 57.5020, 'verified',   'online',  1, 1, 4.0, 3),
  ('20000000-0000-0000-0000-000000000006', -20.1620, 57.5020, 'verified',   'online',  0, 1, 4.0, 3),
  ('20000000-0000-0000-0000-000000000007', -20.1620, 57.5020, 'verified',   'online',  0, 1, 4.0, 3);
INSERT INTO provider_service_categories (provider_id, category_id, approved)
SELECT p, (SELECT id FROM service_categories WHERE slug = 'plumbing'), true
FROM unnest(ARRAY['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003',
                  '20000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000007']::uuid[]) p;
INSERT INTO provider_service_categories (provider_id, category_id, approved)
VALUES ('20000000-0000-0000-0000-000000000006', (SELECT id FROM service_categories WHERE slug = 'electrical'), true);
INSERT INTO service_zones (provider_id, zone_type, center_lat, center_lng, radius_meters, is_primary)
SELECT id, 'radius', home_base_lat, home_base_lng, 30000, true FROM providers WHERE id <> '20000000-0000-0000-0000-000000000007';
-- provider 7 only serves the south of the island (Mahébourg, 10 km radius)
INSERT INTO service_zones (provider_id, zone_type, center_lat, center_lng, radius_meters, is_primary)
VALUES ('20000000-0000-0000-0000-000000000007', 'radius', -20.4081, 57.7000, 10000, true);

INSERT INTO service_requests (id, customer_id, category_id, request_mode, status, description, currency_code, market_id, current_search_radius_m)
VALUES ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        (SELECT id FROM service_categories WHERE slug = 'plumbing-leak'), 'urgent', 'matching', 'Burst pipe under sink', 'MUR',
        '00000000-0000-0000-0000-00000000a001', 5000);
INSERT INTO request_locations (service_request_id, lat, lng, approx_lat, approx_lng, source)
VALUES ('30000000-0000-0000-0000-000000000001', -20.1609, 57.5012, -20.1610, 57.5010, 'gps');

-- ─────────────── dispatch hard filters ───────────────
DO $$
DECLARE ids UUID[];
BEGIN
  SELECT array_agg(provider_id ORDER BY distance_m) INTO ids FROM find_dispatch_candidates('30000000-0000-0000-0000-000000000001', 5000, true);
  IF ids IS DISTINCT FROM ARRAY['20000000-0000-0000-0000-000000000001']::uuid[] THEN
    RAISE EXCEPTION 'FAIL dispatch@5km returned %', ids;
  END IF;
  RAISE NOTICE 'PASS  dispatch @5km: only near, verified, online, in-zone, in-category plumber (subcategory → parent match)';

  SELECT array_agg(provider_id ORDER BY distance_m) INTO ids FROM find_dispatch_candidates('30000000-0000-0000-0000-000000000001', 20000, true);
  IF ids IS DISTINCT FROM ARRAY['20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002']::uuid[] THEN
    RAISE EXCEPTION 'FAIL dispatch@20km returned %', ids;
  END IF;
  RAISE NOTICE 'PASS  radius expansion to 20km picks up the Curepipe plumber; unverified/offline/busy/electrician/out-of-zone still excluded';

  SELECT array_agg(provider_id ORDER BY provider_id) INTO ids FROM find_dispatch_candidates('30000000-0000-0000-0000-000000000001', 5000, false);
  IF NOT ids @> ARRAY['20000000-0000-0000-0000-000000000004']::uuid[] THEN
    RAISE EXCEPTION 'FAIL scheduled dispatch should include offline provider: %', ids;
  END IF;
  RAISE NOTICE 'PASS  non-urgent dispatch includes offline (push-notifiable) providers';
END $$;

-- licence-gated category: unapproved licence → excluded
UPDATE provider_service_categories SET approved = false WHERE provider_id = '20000000-0000-0000-0000-000000000006';
UPDATE service_requests SET category_id = (SELECT id FROM service_categories WHERE slug = 'electrical') WHERE id = '30000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM find_dispatch_candidates('30000000-0000-0000-0000-000000000001', 5000, true)) THEN
    RAISE EXCEPTION 'FAIL electrician without approved licence was dispatched';
  END IF;
  RAISE NOTICE 'PASS  licence-required category excludes providers whose licence is not approved';
END $$;
UPDATE service_requests SET category_id = (SELECT id FROM service_categories WHERE slug = 'plumbing-leak') WHERE id = '30000000-0000-0000-0000-000000000001';

-- ─────────────── quotes ───────────────
INSERT INTO quotes (id, service_request_id, provider_id, amount, currency_code, valid_until)
VALUES ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2000, 'MUR', now() + interval '1 hour'),
       ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 2500, 'MUR', now() + interval '1 hour');
SELECT pg_temp.expect_error($$INSERT INTO quotes (service_request_id, provider_id, amount, currency_code, valid_until)
  VALUES ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1800, 'MUR', now())$$, 'one live quote per provider per request');
UPDATE quotes SET status = 'accepted' WHERE id = '40000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect_error($$UPDATE quotes SET status = 'accepted' WHERE id = '40000000-0000-0000-0000-000000000002'$$, 'only one accepted quote per request');

-- counter offers immutable
INSERT INTO counter_offers (id, quote_id, proposed_by, proposed_by_user_id, amount, currency_code, round_number, valid_until)
VALUES ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'customer', '10000000-0000-0000-0000-000000000001', 2200, 'MUR', 1, now() + interval '1 hour');
SELECT pg_temp.expect_error($$UPDATE counter_offers SET amount = 1 WHERE id = '41000000-0000-0000-0000-000000000001'$$, 'counter-offer amount is immutable');
SELECT pg_temp.expect_error($$DELETE FROM counter_offers WHERE id = '41000000-0000-0000-0000-000000000001'$$, 'counter-offers cannot be deleted');
SELECT pg_temp.expect_error($$INSERT INTO counter_offers (quote_id, proposed_by, proposed_by_user_id, amount, currency_code, round_number, valid_until)
  VALUES ('40000000-0000-0000-0000-000000000002', 'provider', '20000000-0000-0000-0000-000000000002', 2300, 'MUR', 1, now())$$, 'round numbers are unique per quote');

-- ─────────────── booking, payment, fees ───────────────
INSERT INTO payout_accounts (id, provider_id, method, account_holder_name, account_last4, account_details_encrypted, verified, payouts_allowed_after)
VALUES ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'bank_transfer', 'Near Plumber', '1234', '\x00', true, now() - interval '1 day');
INSERT INTO bookings (id, service_request_id, accepted_quote_id, customer_id, provider_id, category_id, agreed_amount, currency_code, payment_due_at, market_id)
VALUES ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', (SELECT id FROM service_categories WHERE slug='plumbing-leak'),
        2000, 'MUR', now() + interval '30 min', '00000000-0000-0000-0000-00000000a001');
DO $$ BEGIN
  IF (SELECT reference FROM bookings WHERE id = '60000000-0000-0000-0000-000000000001') !~ '^TR-[2-9A-Z]{6}$' THEN RAISE EXCEPTION 'FAIL booking reference format'; END IF;
  RAISE NOTICE 'PASS  booking reference generated';
END $$;
INSERT INTO platform_fees (booking_id, fee_bps, fee_amount, currency_code) VALUES ('60000000-0000-0000-0000-000000000001', 1500, 300, 'MUR');
SELECT pg_temp.expect_error($$UPDATE platform_fees SET fee_amount = 0$$, 'frozen platform fee cannot be changed');

INSERT INTO payments (booking_id, attempt, amount_charged_to_customer, currency_code, status, idempotency_key)
VALUES ('60000000-0000-0000-0000-000000000001', 1, 2300, 'MUR', 'failed', 'pay-1'),
       ('60000000-0000-0000-0000-000000000001', 2, 2300, 'MUR', 'captured', 'pay-2');
SELECT pg_temp.expect_error($$INSERT INTO payments (booking_id, attempt, amount_charged_to_customer, currency_code, status, idempotency_key)
  VALUES ('60000000-0000-0000-0000-000000000001', 3, 2300, 'MUR', 'captured', 'pay-3')$$, 'at most one captured payment per booking (no double charge)');
SELECT pg_temp.expect_error($$INSERT INTO payments (booking_id, attempt, amount_charged_to_customer, currency_code, idempotency_key)
  VALUES ('60000000-0000-0000-0000-000000000001', 4, 2300, 'MUR', 'pay-2')$$, 'payment idempotency key is unique');

-- ─────────────── ledger ───────────────
DO $$
DECLARE j UUID := gen_random_uuid();
BEGIN
  INSERT INTO ledger_journals (id, kind, memo, booking_id, currency_code, idempotency_key, actor_type)
  VALUES (j, 'payment_captured', 'test', '60000000-0000-0000-0000-000000000001', 'MUR', 'payment_captured:pay-2', 'system');
  INSERT INTO ledger_entries (journal_id, booking_id, provider_id, account, entry_type, amount, currency_code) VALUES
    (j, '60000000-0000-0000-0000-000000000001', NULL, 'cash_settlement', 'debit', 2300, 'MUR'),
    (j, '60000000-0000-0000-0000-000000000001', NULL, 'platform_fee_revenue', 'credit', 300, 'MUR'),
    (j, '60000000-0000-0000-0000-000000000001', NULL, 'platform_commission_revenue', 'credit', 300, 'MUR'),
    (j, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'provider_payable', 'credit', 1700, 'MUR');
END $$;
DO $$ BEGIN
  IF (SELECT payable FROM provider_balances WHERE provider_id = '20000000-0000-0000-0000-000000000001') <> 1700 THEN RAISE EXCEPTION 'FAIL provider balance'; END IF;
  RAISE NOTICE 'PASS  balanced journal committed; provider_balances view shows MUR 1700 payable';
END $$;
SELECT pg_temp.expect_error($$INSERT INTO ledger_journals (kind, memo, currency_code, idempotency_key, actor_type)
  VALUES ('payment_captured', 'replay', 'MUR', 'payment_captured:pay-2', 'system')$$, 'replayed webhook cannot double-post a journal');
SELECT pg_temp.expect_error($$UPDATE ledger_entries SET amount = 1$$, 'ledger entries are append-only (UPDATE)');
SELECT pg_temp.expect_error($$DELETE FROM ledger_entries$$, 'ledger entries are append-only (DELETE)');
SELECT pg_temp.expect_error($$UPDATE audit_logs SET action = 'x'$$, 'audit log is append-only');
\set ON_ERROR_STOP off
\set QUIET off
BEGIN;
INSERT INTO ledger_journals (id, kind, memo, currency_code, idempotency_key, actor_type)
VALUES ('70000000-0000-0000-0000-000000000009', 'manual_adjustment', 'unbalanced', 'MUR', 'bad-1', 'system');
INSERT INTO ledger_entries (journal_id, account, entry_type, amount, currency_code)
VALUES ('70000000-0000-0000-0000-000000000009', 'cash_settlement', 'debit', 100, 'MUR');
COMMIT;
\set QUIET on
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ledger_journals WHERE id = '70000000-0000-0000-0000-000000000009') THEN RAISE EXCEPTION 'FAIL unbalanced journal committed'; END IF;
  RAISE NOTICE 'PASS  unbalanced journal rejected at COMMIT by deferred constraint trigger';
END $$;

-- ─────────────── payouts ───────────────
UPDATE bookings SET status = 'payout_pending', approved_at = now() - interval '49 hours' WHERE id = '60000000-0000-0000-0000-000000000001';
INSERT INTO payout_records (booking_id, provider_id, payout_account_id, gross_amount, commission_deducted, net_payout_amount, currency_code, eligible_at, idempotency_key)
VALUES ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 2000, 300, 1700, 'MUR', now() - interval '1 hour', 'payout:60000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_error($$INSERT INTO payout_records (booking_id, provider_id, gross_amount, commission_deducted, net_payout_amount, currency_code, eligible_at, idempotency_key)
  VALUES ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2000, 300, 1700, 'MUR', now(), 'other-key')$$, 'second payout row for the same booking (UNIQUE booking_id)');
SELECT pg_temp.expect_error($$UPDATE payout_records SET net_payout_amount = 2000$$, 'net payout must equal gross minus commission');

-- open dispute blocks claim
INSERT INTO disputes (id, booking_id, raised_by_user_id, raised_by_role, reason_code, description, booking_status_at_open, routed_to, sla_due_at)
VALUES ('80000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'customer', 'incomplete_work', 'Leak still there', 'payout_pending', 'support', now() + interval '72 hours');
SELECT pg_temp.expect_error($$INSERT INTO disputes (booking_id, raised_by_role, reason_code, description, booking_status_at_open, routed_to, sla_due_at)
  VALUES ('60000000-0000-0000-0000-000000000001', 'customer', 'other', 'dup', 'payout_pending', 'support', now())$$, 'only one open dispute per booking');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM claim_due_payouts(10)) THEN RAISE EXCEPTION 'FAIL payout claimed despite open dispute'; END IF;
  RAISE NOTICE 'PASS  open dispute blocks payout release';
END $$;
UPDATE disputes SET status = 'resolved', resolution = 'release_to_provider', resolved_at = now() WHERE id = '80000000-0000-0000-0000-000000000001';

-- not yet eligible → not claimed
UPDATE payout_records SET eligible_at = now() + interval '1 hour';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM claim_due_payouts(10)) THEN RAISE EXCEPTION 'FAIL payout claimed before T+48h'; END IF;
  RAISE NOTICE 'PASS  payout not claimable before eligible_at (T+48h)';
END $$;
UPDATE payout_records SET eligible_at = now() - interval '1 minute';

-- claim once, second claim returns nothing
DO $$
DECLARE n1 INT; n2 INT;
BEGIN
  SELECT count(*) INTO n1 FROM claim_due_payouts(10);
  SELECT count(*) INTO n2 FROM claim_due_payouts(10);
  IF n1 <> 1 OR n2 <> 0 THEN RAISE EXCEPTION 'FAIL claim counts % %', n1, n2; END IF;
  RAISE NOTICE 'PASS  payout claimed exactly once (processing), re-claim returns nothing';
END $$;
-- reset for the concurrency test run by run.sh
UPDATE payout_records SET status = 'payout_pending', processing_started_at = NULL;
