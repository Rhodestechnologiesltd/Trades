/* Demo data for local development: 1 customer, 6 verified providers around Mauritius with zones,
   categories and sandbox payout accounts. Never run in production. */
import { Client } from 'pg';
import { config } from '../common/config';
import { encrypt } from '../common/crypto';

const PROVIDERS = [
  { phone: '+23057000001', name: 'Ravi Ramdin', business: 'Ramdin Electrical', lat: -20.1609, lng: 57.5012, cats: ['electrical', 'ac-repair'], instant: true },
  { phone: '+23057000002', name: 'Marie Laval', business: 'Laval Plumbing', lat: -20.2449, lng: 57.4891, cats: ['plumbing', 'handyman'], instant: true },
  { phone: '+23057000003', name: 'Kevin Li', business: null, lat: -20.3163, lng: 57.5259, cats: ['cleaning', 'gardening'], instant: false },
  { phone: '+23057000004', name: 'Anjali Doobur', business: 'Little Stars Care', lat: -20.2654, lng: 57.4791, cats: ['childcare'], instant: false },
  { phone: '+23057000005', name: 'Jean-Paul Bégué', business: 'JP Auto & Tyres', lat: -20.2297, lng: 57.4983, cats: ['mechanics', 'tyre-repair'], instant: true },
  { phone: '+23057000006', name: 'Fatima Hossen', business: 'Hossen Paint & Repair', lat: -20.4081, lng: 57.7000, cats: ['painting', 'appliance-repair', 'handyman'], instant: false },
];

async function main() {
  if (config.isProd) throw new Error('Refusing to seed demo data in production');
  const c = new Client({ connectionString: config.databaseUrl });
  try {
    await c.connect();
  } catch (e: any) {
    throw new Error(`Cannot connect to the database at ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')} (${e.code ?? e.message}).\n` +
      `  → Is Docker Desktop running? Start it, then: docker compose up -d db redis minio\n` +
      `  → Did you load the env file? set -a; source backend/.env; set +a\n` +
      `  → "password authentication failed" means another Postgres owns port 5432: brew services stop postgresql (or quit Postgres.app)`);
  }
  const hasMarkets = (await c.query(`SELECT to_regclass('public.markets') AS t`)).rows[0].t;
  const marketRow = hasMarkets ? (await c.query(`SELECT id FROM markets WHERE country_code = 'MU' LIMIT 1`)).rows[0] : undefined;
  if (!marketRow) {
    throw new Error('Database schema/reference data missing — run migrations first: npm run migrate -w @trades/backend');
  }
  const market = marketRow.id;

  const cust = await c.query(
    `INSERT INTO users (phone_number, email, full_name, user_type, market_id, phone_verified_at) VALUES ('+23059000001','demo.customer@example.mu','Demo Customer','customer',$1,now())
     ON CONFLICT (phone_number) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`, [market]);
  await c.query(`INSERT INTO customers (id) VALUES ($1) ON CONFLICT DO NOTHING`, [cust.rows[0].id]);
  const addr = await c.query(
    `INSERT INTO addresses (owner_user_id, label, line1, city, lat, lng, precision_level)
     SELECT $1, 'Home', '12 Royal Road', 'Rose Hill', -20.2386, 57.4706, 'approximate'
     WHERE NOT EXISTS (SELECT 1 FROM addresses WHERE owner_user_id = $1) RETURNING id`, [cust.rows[0].id]);
  if (addr.rows[0]) await c.query(`UPDATE customers SET default_address_id = $2 WHERE id = $1`, [cust.rows[0].id, addr.rows[0].id]);

  for (const p of PROVIDERS) {
    const u = await c.query(
      `INSERT INTO users (phone_number, full_name, user_type, status, market_id, phone_verified_at) VALUES ($1,$2,'provider','active',$3,now())
       ON CONFLICT (phone_number) DO UPDATE SET status = 'active' RETURNING id`, [p.phone, p.name, market]);
    const id = u.rows[0].id;
    await c.query(
      `INSERT INTO providers (id, business_name, home_base_lat, home_base_lng, verification_status, availability_status, rating_avg, rating_count, instant_accept_enabled, max_concurrent_jobs)
       VALUES ($1,$2,$3,$4,'verified','online',$5,$6,$7,2)
       ON CONFLICT (id) DO UPDATE SET verification_status = 'verified', availability_status = 'online'`,
      [id, p.business, p.lat, p.lng, (4.3 + Math.random() * 0.6).toFixed(2), 10 + Math.floor(Math.random() * 90), p.instant]);
    await c.query(`INSERT INTO provider_profiles (provider_id, bio, years_experience, languages, background_check_status)
                   VALUES ($1,$2,$3,'{en,fr,mfe}',$4) ON CONFLICT (provider_id) DO NOTHING`,
      [id, `${p.business ?? p.name} — reliable, insured and on time.`, 3 + Math.floor(Math.random() * 15), p.cats.includes('childcare') ? 'passed' : 'n/a']);
    await c.query(`DELETE FROM service_zones WHERE provider_id = $1`, [id]);
    await c.query(`INSERT INTO service_zones (provider_id, zone_type, center_lat, center_lng, radius_meters, is_primary) VALUES ($1,'radius',$2,$3,25000,true)`, [id, p.lat, p.lng]);
    for (const slug of p.cats) {
      await c.query(`INSERT INTO provider_service_categories (provider_id, category_id, approved) SELECT $1, id, true FROM service_categories WHERE slug = $2 ON CONFLICT DO NOTHING`, [id, slug]);
    }
    const acct = await c.query(
      `INSERT INTO payout_accounts (provider_id, method, account_holder_name, bank_name, account_last4, account_details_encrypted, verified, payouts_allowed_after)
       SELECT $1,'bank_transfer',$2,'MCB','0042',$3,true,now() - interval '1 day' WHERE NOT EXISTS (SELECT 1 FROM payout_accounts WHERE provider_id = $1) RETURNING id`,
      [id, p.name, encrypt(JSON.stringify({ accountNumber: 'MU17BOMM0101101030300200000MUR', bankCode: 'MCB' }))]);
    if (acct.rows[0]) await c.query(`UPDATE providers SET payout_account_id = $2 WHERE id = $1`, [id, acct.rows[0].id]);
  }
  console.log(`Seeded demo customer +23059000001 and ${PROVIDERS.length} providers (+2305700000[1-6]). Use OTP_DEV_ECHO=true to log in.`);
  await c.end();
}
main().catch(e => { console.error('\nSEED FAILED: ' + (e?.message ?? e) + '\n'); process.exit(1); });
