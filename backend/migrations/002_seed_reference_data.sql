-- Reference data: launch market, launch categories (§A.2), platform configuration defaults.
-- Idempotent: safe to re-run.

INSERT INTO markets (id, country_code, city, currency_code, timezone, center_lat, center_lng, max_dispatch_radius_m)
VALUES ('00000000-0000-0000-0000-00000000a001', 'MU', 'Mauritius', 'MUR', 'Indian/Mauritius', -20.2050, 57.5500, 70000)
ON CONFLICT (country_code, city) DO NOTHING;

INSERT INTO service_categories (slug, name, icon, sort_order, requires_license, requires_background_check, urgency_allowed, average_job_duration_min, instant_accept_price, max_negotiation_rounds)
VALUES
  ('electrical',        'Electricians',            'flash',          10, true,  false, true,  90,  1500.00, NULL),
  ('plumbing',          'Plumbers',                'water',          20, false, false, true,  90,  1500.00, NULL),
  ('childcare',         'Nannies & Babysitters',   'happy',          30, false, true,  false, 240, NULL,    NULL),
  ('cleaning',          'Cleaning Services',       'sparkles',       40, false, false, false, 180, NULL,    NULL),
  ('mechanics',         'Mechanics',               'car',            50, false, false, true,  120, NULL,    NULL),
  ('tyre-repair',       'Tyre Repair',             'disc',           60, false, false, true,  45,  800.00,  NULL),
  ('handyman',          'Handymen',                'hammer',         70, false, false, true,  90,  NULL,    NULL),
  ('ac-repair',         'AC Repair',               'snow',           80, true,  false, true,  90,  2000.00, NULL),
  ('painting',          'Painters',                'color-palette',  90, false, false, false, 480, NULL,    NULL),
  ('gardening',         'Gardeners',               'leaf',          100, false, false, false, 180, NULL,    NULL),
  ('appliance-repair',  'Appliance Repair',        'construct',     110, false, false, true,  90,  NULL,    NULL),
  ('delivery-helpers',  'Delivery Helpers',        'cube',          120, false, false, true,  60,  NULL,    NULL)
ON CONFLICT (slug) DO NOTHING;

-- Example subcategories (admin-managed hierarchy; more can be added without a deploy)
INSERT INTO service_categories (slug, name, parent_id, requires_license, urgency_allowed, sort_order)
SELECT v.slug, v.name, p.id, p.requires_license, v.urgent, v.sort
FROM (VALUES
  ('electrical-wiring',     'Wiring repair',        'electrical', true,  1),
  ('electrical-install',    'Installation',         'electrical', false, 2),
  ('electrical-emergency',  'Emergency callout',    'electrical', true,  3),
  ('plumbing-leak',         'Leaks & burst pipes',  'plumbing',   true,  1),
  ('plumbing-install',      'Fixture installation', 'plumbing',   false, 2),
  ('cleaning-regular',      'Regular home cleaning','cleaning',   false, 1),
  ('cleaning-deep',         'Deep clean',           'cleaning',   false, 2)
) AS v(slug, name, parent_slug, urgent, sort)
JOIN service_categories p ON p.slug = v.parent_slug
ON CONFLICT (slug) DO NOTHING;

INSERT INTO platform_config (key, value, description) VALUES
  ('fees',        '{"customerFeeBps":1500,"providerCommissionBps":1500}', 'Platform default fee (added to customer charge) and commission (deducted from provider payout), basis points. Spec §F.2. Category/market overrides take precedence.'),
  ('timing',      '{"paymentWindowSec":1800,"autoApproveAfterSec":172800,"autoApproveReminderBeforeSec":21600,"payoutDelaySec":172800,"disputeWindowSec":259200,"reviewWindowSec":1209600,"noShowGraceSec":2700}', 'Time windows (§C.5, §C.8, §A.10).'),
  ('negotiation', '{"maxRounds":3}', 'Counter-offer round cap (§A.5).'),
  ('cancellation','{"freeCancelBeforeSec":7200,"lateCancelFeeBps":1000,"lateCancelMinMinor":20000}', 'Cancellation policy.'),
  ('abuse',       '{"maxQuotesPerProviderPerHour":30,"maxUrgentRequestsPerCustomerPerDay":3,"maxPaymentAttemptsPerCustomerPerHour":5,"maxOtpRequestsPerPhonePerHour":5,"clawbackMaxShareOfPayoutBps":5000,"noShowSuspensionThreshold":3}', 'Abuse/fraud limits (§J).'),
  ('dispatch',    '{}', 'Overrides for per-mode dispatch policies; empty = packages/domain DEFAULT_POLICIES.'),
  ('ranking',     '{}', 'Overrides for per-mode ranking weights; empty = DEFAULT_WEIGHTS.'),
  ('support_goodwill_cap', '{"MUR":200000}', 'Max goodwill refund a support agent may issue, minor units per currency (§I).'),
  ('payout_account_cooloff_sec', '86400', 'Payouts to a newly added/changed payout account are delayed by this long (§J).')
ON CONFLICT (key) DO NOTHING;
