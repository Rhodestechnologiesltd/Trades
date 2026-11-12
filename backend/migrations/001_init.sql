-- ════════════════════════════════════════════════════════════════════════════
-- Trades App — initial schema (spec §D)
-- PostgreSQL 15+ with PostGIS 3.
-- Conventions:
--   * money: NUMERIC(12,2) + currency_code on every monetary row (no hard-coded currency)
--   * every geo point: lat/lng DOUBLE PRECISION + generated GEOGRAPHY(POINT,4326), GiST-indexed
--   * every market-scoped row carries market_id (multi-city/country from day one, §B.3)
--   * append-only tables (ledger, audit, state events) are protected by triggers
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Builds a WGS84 geography point. IMMUTABLE so it can back generated columns.
CREATE OR REPLACE FUNCTION make_geog(lat DOUBLE PRECISION, lng DOUBLE PRECISION)
RETURNS GEOGRAPHY(POINT,4326) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN lat IS NULL OR lng IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography END $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001'; END $$;

-- ───────────────────────────── Enums ─────────────────────────────
CREATE TYPE user_type        AS ENUM ('customer','provider','admin','support','finance');
CREATE TYPE user_status      AS ENUM ('active','suspended','banned','pending_verification');
CREATE TYPE actor_type       AS ENUM ('customer','provider','admin','support','finance','system');
CREATE TYPE verification_status AS ENUM ('unverified','pending','verified','rejected');
CREATE TYPE availability_status AS ENUM ('online','offline','busy');
CREATE TYPE background_check_status AS ENUM ('n/a','pending','passed','failed');
CREATE TYPE zone_type        AS ENUM ('radius','polygon');
CREATE TYPE precision_level  AS ENUM ('exact','approximate');
CREATE TYPE location_source  AS ENUM ('gps','manual','saved_address');
CREATE TYPE request_mode     AS ENUM ('recurring','scheduled','urgent');
CREATE TYPE request_status   AS ENUM ('draft','requested','matching','dispatched','quoted','accepted','expired','cancelled');
CREATE TYPE urgency_level    AS ENUM ('normal','high','critical');
CREATE TYPE recurring_status AS ENUM ('active','paused','cancelled');
CREATE TYPE dispatch_status  AS ENUM ('candidate_identified','notified','viewed','quoted','declined','expired_no_response','closed');
CREATE TYPE quote_status     AS ENUM ('submitted','active','countered','accepted','expired','withdrawn','closed');
CREATE TYPE party            AS ENUM ('customer','provider');
CREATE TYPE counter_status   AS ENUM ('proposed','accepted','rejected','expired','countered');
CREATE TYPE booking_status   AS ENUM ('payment_pending','payment_authorized','assigned','in_progress',
                                      'completed_by_provider','approved_by_customer','payout_pending',
                                      'payout_released','cancelled','disputed','refund_pending','refunded');
CREATE TYPE job_event_type   AS ENUM ('assigned','en_route','arrived','started','photo_uploaded','note_added','completed','no_show_reported');
CREATE TYPE payment_status   AS ENUM ('intent_created','authorized','captured','failed','refund_initiated','partially_refunded','refunded');
CREATE TYPE hold_status      AS ENUM ('active','released_to_payout','released_refund','partially_released');
CREATE TYPE payout_method    AS ENUM ('bank_transfer','mobile_wallet');
CREATE TYPE payout_status    AS ENUM ('payout_pending','processing','released','settled','held','clawed_back','cancelled');
CREATE TYPE ledger_account   AS ENUM ('cash_settlement','customer_receivable','provider_clawback_receivable','provider_payable',
                                      'refund_liability','platform_fee_revenue','platform_commission_revenue','platform_reserve');
CREATE TYPE entry_side       AS ENUM ('debit','credit');
CREATE TYPE refund_status    AS ENUM ('initiated','processed','failed');
CREATE TYPE dispute_reason   AS ENUM ('no_show','incomplete_work','damage','overcharge','unsafe_conduct','other');
CREATE TYPE dispute_status   AS ENUM ('opened','under_review','awaiting_evidence','resolved','closed');
CREATE TYPE dispute_resolution AS ENUM ('refund_full','refund_partial','release_to_provider','split');
CREATE TYPE dispute_source   AS ENUM ('platform','chargeback');
CREATE TYPE notification_channel AS ENUM ('push','sms','email','in_app');
CREATE TYPE notification_status  AS ENUM ('queued','sent','delivered','failed','read');
CREATE TYPE clawback_status  AS ENUM ('open','recovering','recovered','written_off','appealed');
CREATE TYPE document_kind    AS ENUM ('id_front','id_back','selfie','license','certificate','background_check','proof_of_address');
CREATE TYPE document_status  AS ENUM ('uploaded','approved','rejected','expired');

-- ───────────────────────────── Markets & config ─────────────────────────────
CREATE TABLE markets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code     TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  city             TEXT NOT NULL,
  currency_code    TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  timezone         TEXT NOT NULL,
  center_lat       DOUBLE PRECISION NOT NULL,
  center_lng       DOUBLE PRECISION NOT NULL,
  max_dispatch_radius_m INT NOT NULL DEFAULT 60000,
  -- per-market overrides of platform fee config (NULL = inherit), in basis points
  customer_fee_bps INT NULL CHECK (customer_fee_bps BETWEEN 0 AND 5000),
  provider_commission_bps INT NULL CHECK (provider_commission_bps BETWEEN 0 AND 5000),
  payment_gateway  TEXT NOT NULL DEFAULT 'mips',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, city)
);

-- Typed key/value config (fees, timing, negotiation, dispatch policies, abuse limits).
CREATE TABLE platform_config (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  description  TEXT,
  updated_by   UUID NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── Identity ─────────────────────────────
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     TEXT UNIQUE,
  email            TEXT UNIQUE,
  password_hash    TEXT NULL,
  full_name        TEXT NOT NULL DEFAULT '',
  avatar_url       TEXT NULL,
  user_type        user_type NOT NULL,
  status           user_status NOT NULL DEFAULT 'active',
  country_code     TEXT NOT NULL DEFAULT 'MU',
  market_id        UUID NULL REFERENCES markets(id),
  locale           TEXT NOT NULL DEFAULT 'en',
  mfa_secret_enc   TEXT NULL,          -- TOTP secret (encrypted) — mandatory for staff (§I/§J)
  mfa_enabled      BOOLEAN NOT NULL DEFAULT false,
  phone_verified_at TIMESTAMPTZ NULL,
  email_verified_at TIMESTAMPTZ NULL,
  last_login_at    TIMESTAMPTZ NULL,
  deleted_at       TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (phone_number IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX users_type_status ON users(user_type, status);

CREATE TABLE otp_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination   TEXT NOT NULL,                 -- E.164 phone or email
  purpose       TEXT NOT NULL,                 -- login | register | payout_account_change | step_up
  code_hash     TEXT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ NULL,
  ip_address    INET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_dest_recent ON otp_challenges(destination, created_at DESC);

-- Refresh tokens are rotated; a reused (already-rotated) token revokes the whole family (§J).
CREATE TABLE auth_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  family_id        UUID NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_id        TEXT NULL,
  device_name      TEXT NULL,
  platform         TEXT NULL,                  -- ios | android | web | admin
  ip_address       INET NULL,
  user_agent       TEXT NULL,
  rotated_at       TIMESTAMPTZ NULL,
  revoked_at       TIMESTAMPTZ NULL,
  revoked_reason   TEXT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family ON auth_sessions(family_id);

CREATE TABLE known_devices (
  user_id       UUID NOT NULL REFERENCES users(id),
  device_id     TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trusted       BOOLEAN NOT NULL DEFAULT false,
  is_rooted     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE push_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  provider   TEXT NOT NULL DEFAULT 'expo' CHECK (provider IN ('expo','fcm','apns')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ NULL
);

CREATE TABLE notification_preferences (
  user_id     UUID NOT NULL REFERENCES users(id),
  event_type  TEXT NOT NULL,
  channels    notification_channel[] NOT NULL,
  PRIMARY KEY (user_id, event_type)
);

-- ───────────────────────────── Addresses ─────────────────────────────
CREATE TABLE addresses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    UUID NOT NULL REFERENCES users(id),
  label            TEXT NOT NULL DEFAULT 'Home',
  line1            TEXT NOT NULL,
  line2            TEXT NULL,
  city             TEXT NOT NULL,
  postal_code      TEXT NULL,
  country_code     TEXT NOT NULL DEFAULT 'MU',
  access_notes     TEXT NULL,          -- gate code etc. — revealed only post-payment
  lat              DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng              DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  geog             GEOGRAPHY(POINT,4326) GENERATED ALWAYS AS (make_geog(lat, lng)) STORED,
  precision_level  precision_level NOT NULL DEFAULT 'approximate',
  deleted_at       TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX addresses_owner ON addresses(owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE customers (
  id                 UUID PRIMARY KEY REFERENCES users(id),
  default_address_id UUID NULL REFERENCES addresses(id),
  rating_avg         NUMERIC(3,2) NULL,
  rating_count       INT NOT NULL DEFAULT 0,
  urgent_requests_today INT NOT NULL DEFAULT 0,
  payment_decline_count INT NOT NULL DEFAULT 0,
  chargeback_count   INT NOT NULL DEFAULT 0,
  loyalty_points     INT NOT NULL DEFAULT 0,            -- phase 2
  fraud_flag         BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── Providers ─────────────────────────────
CREATE TABLE payout_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              UUID NOT NULL REFERENCES users(id),
  method                   payout_method NOT NULL,
  account_holder_name      TEXT NOT NULL,
  bank_name                TEXT NULL,
  account_last4            TEXT NOT NULL,           -- for display only
  account_details_encrypted BYTEA NOT NULL,         -- AES-256-GCM envelope (§J)
  verified                 BOOLEAN NOT NULL DEFAULT false,
  is_default               BOOLEAN NOT NULL DEFAULT true,
  -- cooling-off: payouts to a newly changed account are held (account-takeover defence, §J)
  payouts_allowed_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at              TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id                     UUID PRIMARY KEY REFERENCES users(id),
  business_name          TEXT NULL,
  organization_id        UUID NULL,           -- phase 2: provider organisations/teams
  home_base_lat          DOUBLE PRECISION NULL,
  home_base_lng          DOUBLE PRECISION NULL,
  home_base_geog         GEOGRAPHY(POINT,4326) GENERATED ALWAYS AS (make_geog(home_base_lat, home_base_lng)) STORED,
  last_lat               DOUBLE PRECISION NULL,
  last_lng               DOUBLE PRECISION NULL,
  last_geog              GEOGRAPHY(POINT,4326) GENERATED ALWAYS AS (make_geog(last_lat, last_lng)) STORED,
  last_location_at       TIMESTAMPTZ NULL,
  verification_status    verification_status NOT NULL DEFAULT 'unverified',
  availability_status    availability_status NOT NULL DEFAULT 'offline',
  max_concurrent_jobs    INT NOT NULL DEFAULT 1 CHECK (max_concurrent_jobs BETWEEN 1 AND 20),
  current_active_jobs    INT NOT NULL DEFAULT 0 CHECK (current_active_jobs >= 0),
  instant_accept_enabled BOOLEAN NOT NULL DEFAULT false,
  rating_avg             NUMERIC(3,2) NULL,
  rating_count           INT NOT NULL DEFAULT 0,
  response_speed_avg_sec INT NULL,
  quotes_submitted       INT NOT NULL DEFAULT 0,
  quotes_accepted        INT NOT NULL DEFAULT 0,
  urgent_jobs_assigned   INT NOT NULL DEFAULT 0,
  urgent_jobs_completed  INT NOT NULL DEFAULT 0,
  no_show_count          INT NOT NULL DEFAULT 0,
  fraud_flag             BOOLEAN NOT NULL DEFAULT false,
  payout_account_id      UUID NULL REFERENCES payout_accounts(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX providers_home_geog ON providers USING GIST (home_base_geog);
CREATE INDEX providers_last_geog ON providers USING GIST (last_geog);
CREATE INDEX providers_dispatchable ON providers(availability_status, verification_status);

CREATE TABLE provider_profiles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             UUID NOT NULL UNIQUE REFERENCES providers(id),
  bio                     TEXT NULL,
  years_experience        INT NULL CHECK (years_experience BETWEEN 0 AND 80),
  languages               TEXT[] NOT NULL DEFAULT '{}',
  id_document_url         TEXT NULL,
  license_document_url    TEXT NULL,
  license_number          TEXT NULL,
  license_expires_at      DATE NULL,
  background_check_status background_check_status NOT NULL DEFAULT 'n/a',
  kyc_provider_ref        TEXT NULL,
  rejection_reason        TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   UUID NOT NULL REFERENCES providers(id),
  kind          document_kind NOT NULL,
  category_id   UUID NULL,                       -- licence tied to a trade category
  storage_key   TEXT NOT NULL,                   -- object storage key; served via signed URLs only
  status        document_status NOT NULL DEFAULT 'uploaded',
  expires_at    DATE NULL,
  reviewed_by   UUID NULL REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ NULL,
  notes         TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provider_documents_provider ON provider_documents(provider_id);

-- Raw location pings: retained 30 days then purged (§G.7).
CREATE TABLE provider_location_pings (
  id           BIGSERIAL PRIMARY KEY,
  provider_id  UUID NOT NULL REFERENCES providers(id),
  booking_id   UUID NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  accuracy_m   REAL NULL,
  is_mocked    BOOLEAN NOT NULL DEFAULT false,
  flagged      BOOLEAN NOT NULL DEFAULT false,
  recorded_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pings_provider_time ON provider_location_pings(provider_id, recorded_at DESC);
CREATE INDEX pings_received ON provider_location_pings(received_at);

-- ───────────────────────────── Categories & zones ─────────────────────────────
CREATE TABLE service_categories (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id                 UUID NULL REFERENCES service_categories(id),
  slug                      TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  description               TEXT NULL,
  icon                      TEXT NULL,
  sort_order                INT NOT NULL DEFAULT 0,
  requires_license          BOOLEAN NOT NULL DEFAULT false,
  requires_background_check BOOLEAN NOT NULL DEFAULT false,
  urgency_allowed           BOOLEAN NOT NULL DEFAULT true,
  average_job_duration_min  INT NOT NULL DEFAULT 90,
  -- overrides of the platform fee config (NULL = inherit), basis points
  customer_fee_bps          INT NULL CHECK (customer_fee_bps BETWEEN 0 AND 5000),
  provider_commission_bps   INT NULL CHECK (provider_commission_bps BETWEEN 0 AND 5000),
  -- hard price floor/ceiling for regulated trades, and instant-accept band (§G.4)
  price_floor               NUMERIC(12,2) NULL,
  price_ceiling             NUMERIC(12,2) NULL,
  instant_accept_price      NUMERIC(12,2) NULL,
  max_negotiation_rounds    INT NULL CHECK (max_negotiation_rounds BETWEEN 0 AND 10),
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (price_floor IS NULL OR price_ceiling IS NULL OR price_floor <= price_ceiling)
);
ALTER TABLE provider_documents ADD CONSTRAINT provider_documents_category_fk FOREIGN KEY (category_id) REFERENCES service_categories(id);

-- Suggested price bands per market (guidance only, §A.2)
CREATE TABLE category_price_bands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id  UUID NOT NULL REFERENCES service_categories(id),
  market_id    UUID NOT NULL REFERENCES markets(id),
  sku_name     TEXT NOT NULL,
  suggested_min NUMERIC(12,2) NOT NULL,
  suggested_max NUMERIC(12,2) NOT NULL,
  currency_code TEXT NOT NULL,
  UNIQUE (category_id, market_id, sku_name)
);

CREATE TABLE provider_service_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  category_id     UUID NOT NULL REFERENCES service_categories(id),
  price_band_min  NUMERIC(12,2) NULL,
  price_band_max  NUMERIC(12,2) NULL,
  -- category-specific rating (§A.9)
  rating_avg      NUMERIC(3,2) NULL,
  rating_count    INT NOT NULL DEFAULT 0,
  approved        BOOLEAN NOT NULL DEFAULT false,  -- licence-gated categories need admin approval
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, category_id)
);
CREATE INDEX psc_category ON provider_service_categories(category_id, approved);

CREATE TABLE service_zones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   UUID NOT NULL REFERENCES providers(id),
  zone_type     zone_type NOT NULL,
  center_lat    DOUBLE PRECISION NULL,
  center_lng    DOUBLE PRECISION NULL,
  center_geog   GEOGRAPHY(POINT,4326) GENERATED ALWAYS AS (make_geog(center_lat, center_lng)) STORED,
  radius_meters INT NULL CHECK (radius_meters BETWEEN 500 AND 100000),
  polygon_geog  GEOGRAPHY(POLYGON,4326) NULL,
  city          TEXT NULL,
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((zone_type = 'radius' AND center_lat IS NOT NULL AND radius_meters IS NOT NULL)
      OR (zone_type = 'polygon' AND polygon_geog IS NOT NULL))
);
CREATE INDEX zones_center ON service_zones USING GIST (center_geog);
CREATE INDEX zones_polygon ON service_zones USING GIST (polygon_geog);
CREATE INDEX zones_provider ON service_zones(provider_id);

-- Provider availability calendar (weekly recurring windows + exceptions)
CREATE TABLE provider_availability_windows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID NOT NULL REFERENCES providers(id),
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (start_time < end_time)
);
CREATE TABLE provider_time_off (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID NOT NULL REFERENCES providers(id),
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  CHECK (starts_at < ends_at)
);

-- ───────────────────────────── Requests ─────────────────────────────
CREATE TABLE recurring_agreements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES customers(id),
  category_id           UUID NOT NULL REFERENCES service_categories(id),
  market_id             UUID NOT NULL REFERENCES markets(id),
  address_id            UUID NOT NULL REFERENCES addresses(id),
  preferred_provider_id UUID NULL REFERENCES providers(id),
  cadence_rule          TEXT NOT NULL,              -- RRULE subset (packages/domain/recurrence.ts)
  starts_on             TIMESTAMPTZ NOT NULL,
  duration_min          INT NOT NULL DEFAULT 120,
  description           TEXT NOT NULL,
  agreed_rate           NUMERIC(12,2) NULL,         -- pre-agreed price skips re-quoting
  currency_code         TEXT NOT NULL,
  lead_time_hours       INT NOT NULL DEFAULT 48,    -- generate occurrence N hours ahead
  last_generated_for    TIMESTAMPTZ NULL,
  status                recurring_status NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recurring_active ON recurring_agreements(status) WHERE status = 'active';

CREATE TABLE service_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             UUID NOT NULL REFERENCES customers(id),
  category_id             UUID NOT NULL REFERENCES service_categories(id),
  request_mode            request_mode NOT NULL,
  status                  request_status NOT NULL DEFAULT 'draft',
  title                   TEXT NOT NULL DEFAULT '',
  description             TEXT NOT NULL,
  photo_keys              TEXT[] NOT NULL DEFAULT '{}',
  scheduled_for           TIMESTAMPTZ NULL,
  scheduled_window_min    INT NULL,
  urgency_level           urgency_level NOT NULL DEFAULT 'normal',
  budget_hint             NUMERIC(12,2) NULL,
  currency_code           TEXT NOT NULL,
  recurring_agreement_id  UUID NULL REFERENCES recurring_agreements(id),
  occurrence_at           TIMESTAMPTZ NULL,
  address_id              UUID NULL REFERENCES addresses(id),
  market_id               UUID NOT NULL REFERENCES markets(id),
  current_search_radius_m INT NOT NULL,
  dispatch_wave           INT NOT NULL DEFAULT 0,
  next_dispatch_check_at  TIMESTAMPTZ NULL,
  expires_at              TIMESTAMPTZ NULL,
  admin_assist_requested  BOOLEAN NOT NULL DEFAULT false,
  cancelled_reason        TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (request_mode <> 'scheduled' OR scheduled_for IS NOT NULL),
  UNIQUE (recurring_agreement_id, occurrence_at)    -- one request per recurring occurrence
);
CREATE INDEX requests_dispatch_queue ON service_requests(status, market_id, category_id);
CREATE INDEX requests_customer ON service_requests(customer_id, created_at DESC);
CREATE INDEX requests_next_check ON service_requests(next_dispatch_check_at) WHERE status IN ('dispatched','quoted','matching');

CREATE TABLE request_locations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL UNIQUE REFERENCES service_requests(id),
  lat                DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  geog               GEOGRAPHY(POINT,4326) GENERATED ALWAYS AS (make_geog(lat, lng)) STORED,
  -- obfuscated point shown to providers before acceptance (§G.7)
  approx_lat         DOUBLE PRECISION NOT NULL,
  approx_lng         DOUBLE PRECISION NOT NULL,
  precision_level    precision_level NOT NULL DEFAULT 'approximate',
  source             location_source NOT NULL,
  address_text       TEXT NULL,
  area_label         TEXT NULL,                    -- e.g. "Quatre Bornes" — safe to show pre-acceptance
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX request_locations_geog ON request_locations USING GIST (geog);

CREATE TABLE provider_dispatches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  provider_id        UUID NOT NULL REFERENCES providers(id),
  status             dispatch_status NOT NULL DEFAULT 'candidate_identified',
  wave               INT NOT NULL DEFAULT 1,
  rank_score         NUMERIC(8,6) NULL,
  distance_m         INT NOT NULL,
  notified_at        TIMESTAMPTZ NULL,
  viewed_at          TIMESTAMPTZ NULL,
  responded_at       TIMESTAMPTZ NULL,
  response_deadline  TIMESTAMPTZ NULL,
  decline_reason     TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_request_id, provider_id)
);
CREATE INDEX dispatches_request ON provider_dispatches(service_request_id, status);
CREATE INDEX dispatches_provider ON provider_dispatches(provider_id, status, notified_at);

CREATE TABLE quotes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  provider_id        UUID NOT NULL REFERENCES providers(id),
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency_code      TEXT NOT NULL,
  message            TEXT NULL,
  estimated_start_at TIMESTAMPTZ NULL,
  estimated_duration_min INT NULL,
  valid_until        TIMESTAMPTZ NOT NULL,
  status             quote_status NOT NULL DEFAULT 'active',
  round_number       INT NOT NULL DEFAULT 0,
  is_instant_accept  BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one LIVE quote per provider per request (§A.4); withdrawn/expired quotes don't block a new one
CREATE UNIQUE INDEX quotes_one_live_per_provider ON quotes(service_request_id, provider_id)
  WHERE status IN ('submitted','active','countered','accepted');
-- at most one accepted quote per request
CREATE UNIQUE INDEX quotes_one_accepted ON quotes(service_request_id) WHERE status = 'accepted';
CREATE INDEX quotes_request_status ON quotes(service_request_id, status);
CREATE INDEX quotes_expiry ON quotes(valid_until) WHERE status IN ('active','countered','submitted');
CREATE INDEX quotes_provider ON quotes(provider_id, created_at DESC);

CREATE TABLE counter_offers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id                UUID NOT NULL REFERENCES quotes(id),
  proposed_by             party NOT NULL,
  proposed_by_user_id     UUID NOT NULL REFERENCES users(id),
  amount                  NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency_code           TEXT NOT NULL,
  message                 TEXT NULL,
  round_number            INT NOT NULL CHECK (round_number >= 1),
  status                  counter_status NOT NULL DEFAULT 'proposed',
  parent_counter_offer_id UUID NULL REFERENCES counter_offers(id),
  valid_until             TIMESTAMPTZ NOT NULL,
  responded_at            TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_id, round_number)
);
-- Counter-offer rows are immutable apart from their status/responded_at (§A.5).
CREATE OR REPLACE FUNCTION counter_offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.proposed_by <> OLD.proposed_by OR NEW.round_number <> OLD.round_number
     OR NEW.quote_id <> OLD.quote_id OR COALESCE(NEW.message,'') <> COALESCE(OLD.message,'') THEN
    RAISE EXCEPTION 'counter_offers are immutable; only status may change';
  END IF;
  IF OLD.status <> 'proposed' THEN RAISE EXCEPTION 'counter offer % already resolved', OLD.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER counter_offers_immutable BEFORE UPDATE ON counter_offers FOR EACH ROW EXECUTE FUNCTION counter_offers_guard();
CREATE TRIGGER counter_offers_no_delete BEFORE DELETE ON counter_offers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── Bookings ─────────────────────────────
CREATE TABLE bookings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                 TEXT NOT NULL UNIQUE,      -- human-friendly e.g. TR-7K3D9Q
  service_request_id        UUID NOT NULL UNIQUE REFERENCES service_requests(id),
  accepted_quote_id         UUID NOT NULL UNIQUE REFERENCES quotes(id),
  accepted_counter_offer_id UUID NULL REFERENCES counter_offers(id),
  customer_id               UUID NOT NULL REFERENCES customers(id),
  provider_id               UUID NOT NULL REFERENCES providers(id),
  category_id               UUID NOT NULL REFERENCES service_categories(id),
  agreed_amount             NUMERIC(12,2) NOT NULL CHECK (agreed_amount > 0),
  currency_code             TEXT NOT NULL,
  status                    booking_status NOT NULL DEFAULT 'payment_pending',
  scheduled_start_at        TIMESTAMPTZ NULL,
  payment_due_at            TIMESTAMPTZ NOT NULL,
  job_started_at            TIMESTAMPTZ NULL,
  job_completed_at          TIMESTAMPTZ NULL,
  approved_at               TIMESTAMPTZ NULL,
  auto_approve_at           TIMESTAMPTZ NULL,
  auto_approve_reminded_at  TIMESTAMPTZ NULL,
  dispute_deadline_at       TIMESTAMPTZ NULL,
  cancelled_at              TIMESTAMPTZ NULL,
  cancelled_by              actor_type NULL,
  cancel_reason             TEXT NULL,
  completion_notes          TEXT NULL,
  market_id                 UUID NOT NULL REFERENCES markets(id),
  version                   INT NOT NULL DEFAULT 0,     -- optimistic concurrency
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bookings_status_auto_approve ON bookings(status, auto_approve_at);
CREATE INDEX bookings_payment_due ON bookings(payment_due_at) WHERE status = 'payment_pending';
CREATE INDEX bookings_customer ON bookings(customer_id, created_at DESC);
CREATE INDEX bookings_provider ON bookings(provider_id, created_at DESC);
CREATE INDEX bookings_market_status ON bookings(market_id, status);

CREATE TABLE job_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  event_type    job_event_type NOT NULL,
  actor_user_id UUID NULL REFERENCES users(id),
  lat           DOUBLE PRECISION NULL,
  lng           DOUBLE PRECISION NULL,
  within_geofence BOOLEAN NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_events_booking ON job_events(booking_id, occurred_at);

-- Generic event-sourced transition history for every state machine (§C preamble).
CREATE TABLE state_events (
  id           BIGSERIAL PRIMARY KEY,
  entity_type  TEXT NOT NULL,     -- service_request | quote | counter_offer | booking | payment | payout | dispute | provider_dispatch
  entity_id    UUID NOT NULL,
  from_state   TEXT NULL,
  to_state     TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  actor_type   actor_type NOT NULL,
  actor_user_id UUID NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX state_events_entity ON state_events(entity_type, entity_id, id);
CREATE TRIGGER state_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON state_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── Payments ─────────────────────────────
CREATE TABLE payments (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                 UUID NOT NULL REFERENCES bookings(id),
  attempt                    INT NOT NULL DEFAULT 1,
  gateway                    TEXT NOT NULL DEFAULT 'mips',
  gateway_reference          TEXT NULL UNIQUE,     -- MIPS transaction id
  gateway_session_id         TEXT NULL,
  amount_charged_to_customer NUMERIC(12,2) NOT NULL CHECK (amount_charged_to_customer > 0),
  amount_refunded            NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency_code              TEXT NOT NULL,
  status                     payment_status NOT NULL DEFAULT 'intent_created',
  idempotency_key            TEXT NOT NULL UNIQUE,
  failure_code               TEXT NULL,
  failure_message            TEXT NULL,
  card_brand                 TEXT NULL,
  card_last4                 TEXT NULL,
  raised_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at                TIMESTAMPTZ NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, attempt),
  CHECK (amount_refunded >= 0 AND amount_refunded <= amount_charged_to_customer)
);
-- Only ONE live captured payment per booking (double-charge guard). A duplicate charge that
-- arrives anyway is recorded straight into refund_initiated and refunded in full.
CREATE UNIQUE INDEX payments_one_captured ON payments(booking_id)
  WHERE status IN ('captured','partially_refunded');

CREATE TABLE payment_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway         TEXT NOT NULL,
  event_id        TEXT NOT NULL,                  -- gateway's own event/transaction id → dedupe
  signature_valid BOOLEAN NOT NULL,
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ NULL,
  error           TEXT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_id)
);

CREATE TABLE payment_holds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    UUID NOT NULL UNIQUE REFERENCES payments(id),
  booking_id    UUID NOT NULL UNIQUE REFERENCES bookings(id),
  held_amount   NUMERIC(12,2) NOT NULL CHECK (held_amount >= 0),
  currency_code TEXT NOT NULL,
  hold_status   hold_status NOT NULL DEFAULT 'active',
  released_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Frozen at booking creation; never recalculated (§F.2)
CREATE TABLE platform_fees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL UNIQUE REFERENCES bookings(id),
  fee_bps       INT NOT NULL,
  fee_pct       NUMERIC(5,2) GENERATED ALWAYS AS (fee_bps / 100.0) STORED,
  fee_amount    NUMERIC(12,2) NOT NULL CHECK (fee_amount >= 0),
  currency_code TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE platform_commissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL UNIQUE REFERENCES bookings(id),
  commission_bps    INT NOT NULL,
  commission_pct    NUMERIC(5,2) GENERATED ALWAYS AS (commission_bps / 100.0) STORED,
  commission_amount NUMERIC(12,2) NOT NULL CHECK (commission_amount >= 0),
  currency_code     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_fees_frozen BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_fees FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER platform_commissions_frozen BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_commissions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TABLE refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID NOT NULL REFERENCES bookings(id),
  payment_id       UUID NOT NULL REFERENCES payments(id),
  dispute_id       UUID NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency_code    TEXT NOT NULL,
  adjusted_agreed_amount NUMERIC(12,2) NOT NULL,   -- settlement basis (packages/domain computeSettlement)
  reason           TEXT NOT NULL,
  rail             TEXT NOT NULL DEFAULT 'gateway' CHECK (rail IN ('gateway','bank_transfer')),
  gateway_reference TEXT NULL,
  status           refund_status NOT NULL DEFAULT 'initiated',
  idempotency_key  TEXT NOT NULL UNIQUE,
  initiated_by     UUID NULL REFERENCES users(id),
  initiated_by_type actor_type NOT NULL,
  processed_at     TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_booking ON refunds(booking_id);

-- ───────────────────────────── Payouts ─────────────────────────────
CREATE TABLE payout_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL UNIQUE REFERENCES bookings(id),   -- ONE payout per booking (§F.4)
  provider_id         UUID NOT NULL REFERENCES providers(id),
  payout_account_id   UUID NULL REFERENCES payout_accounts(id),
  gross_amount        NUMERIC(12,2) NOT NULL CHECK (gross_amount >= 0),
  commission_deducted NUMERIC(12,2) NOT NULL CHECK (commission_deducted >= 0),
  net_payout_amount   NUMERIC(12,2) NOT NULL CHECK (net_payout_amount >= 0),
  clawback_recovered  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (clawback_recovered >= 0),
  currency_code       TEXT NOT NULL,
  status              payout_status NOT NULL DEFAULT 'payout_pending',
  eligible_at         TIMESTAMPTZ NOT NULL,            -- approved_at + 48h
  dispute_flag        BOOLEAN NOT NULL DEFAULT false,
  hold_reason         TEXT NULL,
  batch_id            UUID NULL,
  disbursement_reference TEXT NULL,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT NULL,
  processing_started_at TIMESTAMPTZ NULL,
  released_at         TIMESTAMPTZ NULL,
  settled_at          TIMESTAMPTZ NULL,
  idempotency_key     TEXT NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (net_payout_amount = gross_amount - commission_deducted),
  CHECK (clawback_recovered <= net_payout_amount)
);
CREATE INDEX payouts_due ON payout_records(status, eligible_at) WHERE status = 'payout_pending' AND dispute_flag = false;
CREATE INDEX payouts_processing ON payout_records(processing_started_at) WHERE status = 'processing';
CREATE INDEX payouts_provider ON payout_records(provider_id, created_at DESC);

CREATE TABLE payout_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     UUID NOT NULL REFERENCES markets(id),
  currency_code TEXT NOT NULL,
  total_amount  NUMERIC(14,2) NOT NULL,
  payout_count  INT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','held','exported','completed')),
  approved_by   UUID NULL REFERENCES users(id),
  approved_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payout_records ADD CONSTRAINT payout_records_batch_fk FOREIGN KEY (batch_id) REFERENCES payout_batches(id);

CREATE TABLE provider_clawbacks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  booking_id      UUID NOT NULL REFERENCES bookings(id),
  refund_id       UUID NULL REFERENCES refunds(id),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  recovered_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency_code   TEXT NOT NULL,
  status          clawback_status NOT NULL DEFAULT 'open',
  appeal_notes    TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (recovered_amount <= amount)
);
CREATE INDEX clawbacks_open ON provider_clawbacks(provider_id) WHERE status IN ('open','recovering');

-- ───────────────────────────── Ledger (append-only double entry) ─────────────────────────────
CREATE TABLE ledger_journals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL,
  memo          TEXT NOT NULL,
  booking_id    UUID NULL REFERENCES bookings(id),
  reference_id  UUID NULL,
  reference_type TEXT NULL,
  currency_code TEXT NOT NULL,
  -- one journal per (kind, reference): replays of the same webhook/job cannot double-post
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_type    actor_type NOT NULL,
  actor_user_id UUID NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  journal_id    UUID NOT NULL REFERENCES ledger_journals(id),
  booking_id    UUID NULL REFERENCES bookings(id),
  provider_id   UUID NULL REFERENCES providers(id),   -- sub-ledger for provider_payable / clawback
  account       ledger_account NOT NULL,
  entry_type    entry_side NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL,
  reference_id  UUID NULL,
  reference_type TEXT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account ON ledger_entries(account, currency_code, recorded_at);
CREATE INDEX ledger_entries_booking ON ledger_entries(booking_id);
CREATE INDEX ledger_entries_provider ON ledger_entries(provider_id, account);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_journals FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Every journal must balance per currency at COMMIT (deferred constraint trigger).
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE imbalance NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END), 0)
    INTO imbalance FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced by %', NEW.journal_id, imbalance USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

CREATE VIEW ledger_account_balances AS
SELECT account, currency_code,
       SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END) *
       CASE WHEN account IN ('cash_settlement','customer_receivable','provider_clawback_receivable') THEN 1 ELSE -1 END AS balance
FROM ledger_entries GROUP BY account, currency_code;

CREATE VIEW provider_balances AS
SELECT provider_id, currency_code,
  SUM(CASE WHEN account = 'provider_payable' THEN (CASE WHEN entry_type='credit' THEN amount ELSE -amount END) ELSE 0 END) AS payable,
  SUM(CASE WHEN account = 'provider_clawback_receivable' THEN (CASE WHEN entry_type='debit' THEN amount ELSE -amount END) ELSE 0 END) AS clawback_owed
FROM ledger_entries WHERE provider_id IS NOT NULL GROUP BY provider_id, currency_code;

-- Gateway settlement reports imported by finance for daily reconciliation (§F.3)
CREATE TABLE settlement_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway        TEXT NOT NULL,
  report_date    DATE NOT NULL,
  currency_code  TEXT NOT NULL,
  gross_amount   NUMERIC(14,2) NOT NULL,
  fees_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount     NUMERIC(14,2) NOT NULL,
  line_count     INT NOT NULL,
  raw            JSONB NOT NULL,
  imported_by    UUID NULL REFERENCES users(id),
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, report_date, currency_code)
);
CREATE TABLE reconciliation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       UUID NULL REFERENCES settlement_reports(id),
  run_date        DATE NOT NULL,
  currency_code   TEXT NOT NULL,
  ledger_captured NUMERIC(14,2) NOT NULL,
  gateway_captured NUMERIC(14,2) NULL,
  difference      NUMERIC(14,2) NULL,
  unmatched       JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL CHECK (status IN ('matched','mismatch','pending_report')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────────── Reviews & disputes ─────────────────────────────
CREATE TABLE reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL REFERENCES bookings(id),
  category_id        UUID NOT NULL REFERENCES service_categories(id),
  reviewer_user_id   UUID NOT NULL REFERENCES users(id),
  reviewee_user_id   UUID NOT NULL REFERENCES users(id),
  reviewer_role      party NOT NULL,
  rating             SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment            TEXT NULL,
  comment_original   TEXT NULL,       -- pre-moderation text, staff-only
  category_breakdown JSONB NOT NULL DEFAULT '{}',
  moderation_flags   TEXT[] NOT NULL DEFAULT '{}',
  is_hidden          BOOLEAN NOT NULL DEFAULT false,
  hidden_by          UUID NULL REFERENCES users(id),
  hidden_reason      TEXT NULL,
  visible_at         TIMESTAMPTZ NOT NULL,     -- double-blind release
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, reviewer_user_id),
  CHECK (reviewer_user_id <> reviewee_user_id)
);
CREATE INDEX reviews_reviewee ON reviews(reviewee_user_id, visible_at DESC);

CREATE TABLE disputes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id),
  raised_by_user_id   UUID NULL REFERENCES users(id),
  raised_by_role      actor_type NOT NULL,
  source              dispute_source NOT NULL DEFAULT 'platform',
  reason_code         dispute_reason NOT NULL,
  description         TEXT NOT NULL,
  status              dispute_status NOT NULL DEFAULT 'opened',
  booking_status_at_open booking_status NOT NULL,
  routed_to           TEXT NOT NULL,
  assigned_to_user_id UUID NULL REFERENCES users(id),
  sla_due_at          TIMESTAMPTZ NOT NULL,
  evidence_due_at     TIMESTAMPTZ NULL,
  resolution          dispute_resolution NULL,
  resolution_amount   NUMERIC(12,2) NULL,      -- adjusted agreed amount used for settlement
  resolution_notes    TEXT NULL,
  resolved_by_user_id UUID NULL REFERENCES users(id),
  chargeback_reference TEXT NULL,
  chargeback_respond_by TIMESTAMPTZ NULL,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'resolved' OR resolution IS NOT NULL)
);
-- only one open dispute per booking
CREATE UNIQUE INDEX disputes_one_open ON disputes(booking_id) WHERE status IN ('opened','under_review','awaiting_evidence');
CREATE INDEX disputes_queue ON disputes(status, routed_to, sla_due_at);
ALTER TABLE refunds ADD CONSTRAINT refunds_dispute_fk FOREIGN KEY (dispute_id) REFERENCES disputes(id);

CREATE TABLE dispute_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    UUID NOT NULL REFERENCES disputes(id),
  author_user_id UUID NULL REFERENCES users(id),
  author_role   actor_type NOT NULL,
  body          TEXT NOT NULL,
  attachment_keys TEXT[] NOT NULL DEFAULT '{}',
  internal_only BOOLEAN NOT NULL DEFAULT false,   -- staff notes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER dispute_messages_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON dispute_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- In-booking chat between customer and provider (moderated; contact details redacted pre-payment)
CREATE TABLE booking_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  sender_user_id UUID NOT NULL REFERENCES users(id),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  redacted      BOOLEAN NOT NULL DEFAULT false,
  read_at       TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX booking_messages_thread ON booking_messages(service_request_id, created_at);

-- ───────────────────────────── Notifications ─────────────────────────────
CREATE TABLE notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  channel           notification_channel NOT NULL,
  event_type        TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  status            notification_status NOT NULL DEFAULT 'queued',
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error        TEXT NULL,
  provider_message_id TEXT NULL,
  dedupe_key        TEXT NULL,
  sent_at           TIMESTAMPTZ NULL,
  delivered_at      TIMESTAMPTZ NULL,
  read_at           TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key, channel)
);
CREATE INDEX notifications_feed ON notifications(recipient_user_id, created_at DESC) WHERE channel = 'in_app';
CREATE INDEX notifications_outbox ON notifications(status, next_attempt_at) WHERE status = 'queued';

-- Transactional outbox: domain events written in the same tx as the state change,
-- then relayed to the event bus (Kafka) / in-process consumers (§B.3).
CREATE TABLE outbox_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id  UUID NOT NULL,
  payload       JSONB NOT NULL,
  market_id     UUID NULL,
  published_at  TIMESTAMPTZ NULL,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished ON outbox_events(id) WHERE published_at IS NULL;

-- ───────────────────────────── Idempotency & audit ─────────────────────────────
CREATE TABLE idempotency_keys (
  key             TEXT NOT NULL,
  user_id         UUID NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status_code     INT NULL,
  response_body   JSONB NULL,
  locked_until    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_created ON idempotency_keys(created_at);

CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID NULL,
  actor_type    actor_type NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     UUID NULL,
  before_state  JSONB NULL,
  after_state   JSONB NULL,
  reason        TEXT NULL,
  ip_address    INET NULL,
  user_agent    TEXT NULL,
  request_id    TEXT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_logs(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_actor ON audit_logs(actor_user_id, occurred_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Field-level access log for sensitive reads: exact addresses, location history, documents (§J, §G.7)
CREATE TABLE sensitive_access_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID NULL,
  actor_type    actor_type NOT NULL,
  subject_user_id UUID NULL,
  resource      TEXT NOT NULL,     -- exact_address | location_history | kyc_document | payout_account
  resource_id   UUID NULL,
  purpose       TEXT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sensitive_subject ON sensitive_access_logs(subject_user_id, occurred_at DESC);

-- Fraud / abuse review queue (§J)
CREATE TABLE fraud_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID NOT NULL REFERENCES users(id),
  signal        TEXT NOT NULL,     -- location_jump | mock_location | quote_spam | fake_completion | collusion | card_testing | chargeback_rate | urgent_abuse | no_show
  severity      SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  booking_id    UUID NULL REFERENCES bookings(id),
  details       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  reviewed_by   UUID NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fraud_open ON fraud_signals(status, severity DESC, created_at);

-- updated_at triggers
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['markets','users','addresses','customers','providers','provider_profiles','service_categories',
    'recurring_agreements','service_requests','quotes','bookings','payments','payout_records','provider_clawbacks','disputes']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
