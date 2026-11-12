/* Applies backend/migrations/*.sql in order, once each, inside transactions. */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { config } from '../common/config';

async function main() {
  const client = new Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
  } catch (e: any) {
    throw new Error(`Cannot connect to the database at ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')} (${e.code ?? e.message}).\n` +
      `  → Is Docker Desktop running? Start it, then: docker compose up -d db redis minio  (and check: docker compose ps)\n` +
      `  → Did you load the env file? set -a; source backend/.env; set +a\n` +
      `  → "password authentication failed" means another Postgres owns port 5432: brew services stop postgresql (or quit Postgres.app)`);
  }
  console.log('connected to database');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // works from src/scripts (ts-node) and dist/src/scripts (compiled)
  const dir = [join(__dirname, '..', '..', 'migrations'), join(__dirname, '..', '..', '..', 'migrations')].find(existsSync)!;
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await client.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [f]);
    if (done.rowCount) continue;
    process.stdout.write(`applying ${f} … `);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('FAILED');
      throw e;
    }
  }
  await client.end();
}
main().catch(e => { console.error('\nMIGRATE FAILED: ' + (e?.message ?? e) + '\n'); process.exit(1); });
