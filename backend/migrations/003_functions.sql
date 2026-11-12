-- Database functions for the two hot/critical paths, kept in SQL so the hard
-- filters can never be bypassed by application refactors (§G.6) and so the
-- payout claim is atomic (§F.4).

-- ─────────────── Dispatch candidate search (§G.1, §G.6) ───────────────
-- HARD filters only. Ranking happens in packages/domain (rankCandidates).
CREATE OR REPLACE FUNCTION find_dispatch_candidates(
  p_request_id      UUID,
  p_radius_m        INT,
  p_require_online  BOOLEAN DEFAULT true,
  p_limit           INT DEFAULT 200
) RETURNS TABLE (
  provider_id            UUID,
  distance_m             INT,
  rating_avg             NUMERIC,
  rating_count           INT,
  active_jobs            INT,
  max_concurrent_jobs    INT,
  response_speed_avg_sec INT,
  urgent_completion_rate NUMERIC,
  quote_conversion_rate  NUMERIC,
  no_show_count          INT,
  instant_accept_enabled BOOLEAN
) LANGUAGE sql STABLE AS $$
  WITH req AS (
    SELECT r.id, r.market_id, r.category_id, r.request_mode, r.scheduled_for, r.customer_id,
           c.parent_id AS parent_category_id, c.requires_license, c.requires_background_check,
           COALESCE(pc.requires_license, false) AS parent_requires_license,
           COALESCE(pc.requires_background_check, false) AS parent_requires_bg,
           l.geog
    FROM service_requests r
    JOIN request_locations l ON l.service_request_id = r.id
    JOIN service_categories c ON c.id = r.category_id
    LEFT JOIN service_categories pc ON pc.id = c.parent_id
    WHERE r.id = p_request_id
  )
  SELECT p.id,
         ST_Distance(COALESCE(p.last_geog, p.home_base_geog), req.geog)::INT,
         COALESCE(psc.rating_avg, p.rating_avg),
         COALESCE(NULLIF(psc.rating_count, 0), p.rating_count),
         p.current_active_jobs,
         p.max_concurrent_jobs,
         p.response_speed_avg_sec,
         CASE WHEN p.urgent_jobs_assigned > 0 THEN p.urgent_jobs_completed::NUMERIC / p.urgent_jobs_assigned END,
         CASE WHEN p.quotes_submitted >= 5 THEN p.quotes_accepted::NUMERIC / p.quotes_submitted END,
         p.no_show_count,
         p.instant_accept_enabled
  FROM req
  JOIN providers p ON true
  JOIN users u ON u.id = p.id
  -- category eligibility: exact category, or the parent of a requested subcategory
  JOIN provider_service_categories psc
    ON psc.provider_id = p.id
   AND psc.category_id IN (req.category_id, req.parent_category_id)
  LEFT JOIN provider_profiles pp ON pp.provider_id = p.id
  WHERE u.status = 'active'
    AND u.deleted_at IS NULL
    AND u.market_id = req.market_id                                   -- coarse market pre-filter
    AND p.id <> req.customer_id                                        -- no self-dispatch
    AND p.verification_status = 'verified'
    AND p.fraud_flag = false
    AND p.home_base_geog IS NOT NULL
    AND (NOT (req.requires_license OR req.parent_requires_license) OR psc.approved)
    AND (NOT (req.requires_background_check OR req.parent_requires_bg) OR pp.background_check_status = 'passed')
    AND p.current_active_jobs < p.max_concurrent_jobs
    -- urgent: must be online now; scheduled/recurring: offline providers are still notified (push) — §G.1
    AND (NOT p_require_online OR p.availability_status = 'online')
    -- search radius around the job (expands over time, §G.2)
    AND ST_DWithin(COALESCE(p.last_geog, p.home_base_geog), req.geog, p_radius_m)
    -- the job must fall inside one of the provider's own service zones
    AND EXISTS (
      SELECT 1 FROM service_zones z
      WHERE z.provider_id = p.id
        AND ((z.zone_type = 'radius'  AND ST_DWithin(z.center_geog, req.geog, z.radius_meters))
          OR (z.zone_type = 'polygon' AND ST_Covers(z.polygon_geog, req.geog)))
    )
    -- scheduled jobs: provider not on time off at that moment
    AND (req.scheduled_for IS NULL OR NOT EXISTS (
      SELECT 1 FROM provider_time_off t
      WHERE t.provider_id = p.id AND req.scheduled_for >= t.starts_at AND req.scheduled_for < t.ends_at
    ))
  ORDER BY 2
  LIMIT p_limit
$$;

-- ─────────────── Atomic payout claim (§C.8, §F.4) ───────────────
-- Claims due payouts with FOR UPDATE SKIP LOCKED and flips them to 'processing'
-- in the same statement. Concurrent workers never claim the same row; the
-- disbursement call happens only AFTER this transaction commits.
CREATE OR REPLACE FUNCTION claim_due_payouts(p_limit INT DEFAULT 50, p_now TIMESTAMPTZ DEFAULT now())
RETURNS SETOF payout_records LANGUAGE sql AS $$
  UPDATE payout_records pr
     SET status = 'processing',
         processing_started_at = p_now,
         attempts = pr.attempts + 1
   WHERE pr.id IN (
     SELECT r.id
       FROM payout_records r
       JOIN bookings b ON b.id = r.booking_id
       LEFT JOIN payout_accounts a ON a.id = r.payout_account_id
      WHERE r.status = 'payout_pending'
        AND r.dispute_flag = false
        AND r.eligible_at <= p_now
        AND b.status = 'payout_pending'
        AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = r.booking_id
                         AND d.status IN ('opened','under_review','awaiting_evidence'))
        AND a.id IS NOT NULL AND a.disabled_at IS NULL AND a.payouts_allowed_after <= p_now
      ORDER BY r.eligible_at
      LIMIT p_limit
      FOR UPDATE OF r SKIP LOCKED
   )
  RETURNING pr.*
$$;

-- Payouts stuck in 'processing' (worker crashed between claim and confirmation)
-- are surfaced for the reconciliation sweep, which checks the disbursement rail
-- by idempotency key BEFORE any retry — never blind re-disbursement.
CREATE OR REPLACE FUNCTION stale_processing_payouts(p_older_than INTERVAL DEFAULT '15 minutes')
RETURNS SETOF payout_records LANGUAGE sql STABLE AS $$
  SELECT * FROM payout_records
   WHERE status = 'processing' AND processing_started_at < now() - p_older_than
   ORDER BY processing_started_at
$$;

-- Booking reference generator: TR-XXXXXX (no ambiguous chars)
CREATE OR REPLACE FUNCTION gen_booking_reference() RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE alphabet TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; ref TEXT := 'TR-'; i INT;
BEGIN
  FOR i IN 1..6 LOOP ref := ref || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1); END LOOP;
  RETURN ref;
END $$;
ALTER TABLE bookings ALTER COLUMN reference SET DEFAULT gen_booking_reference();

-- Recompute provider rating aggregates (overall + per category) from visible reviews.
CREATE OR REPLACE FUNCTION refresh_provider_rating(p_provider_id UUID) RETURNS void LANGUAGE sql AS $$
  UPDATE providers p SET
    rating_avg = s.avg, rating_count = s.cnt
  FROM (SELECT ROUND(AVG(rating)::NUMERIC, 2) AS avg, COUNT(*)::INT AS cnt
          FROM reviews WHERE reviewee_user_id = p_provider_id AND reviewer_role = 'customer'
           AND NOT is_hidden AND visible_at <= clock_timestamp()) s
  WHERE p.id = p_provider_id;
  UPDATE provider_service_categories psc SET
    rating_avg = s.avg, rating_count = s.cnt
  FROM (SELECT r.category_id, ROUND(AVG(r.rating)::NUMERIC, 2) AS avg, COUNT(*)::INT AS cnt
          FROM reviews r WHERE r.reviewee_user_id = p_provider_id AND r.reviewer_role = 'customer'
           AND NOT r.is_hidden AND r.visible_at <= clock_timestamp() GROUP BY r.category_id) s
  WHERE psc.provider_id = p_provider_id AND psc.category_id = s.category_id;
$$;
