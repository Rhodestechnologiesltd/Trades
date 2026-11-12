import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from './config';
import { NotFoundError } from './errors';

// Keep NUMERIC as string (exact) — converted to integer minor units via @trades/domain.
types.setTypeParser(1700, (v: string) => v);
// BIGINT counts → number (safe for our counters)
types.setTypeParser(20, (v: string) => Number(v));

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 15_000 } as any);

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T[]> {
    return (await q.query<T>(sql, params as any[])).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T | null> {
    const rows = await this.many<T>(sql, params, q);
    return rows[0] ?? null;
  }

  async oneOrFail<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = this.pool, what = 'Resource'): Promise<T> {
    const row = await this.one<T>(sql, params, q);
    if (!row) throw new NotFoundError(`${what} not found`);
    return row;
  }

  /**
   * Runs fn in a transaction. Serialization failures / deadlocks are retried
   * (bounded) because every money/state mutation is written to be idempotent.
   */
  async tx<T>(fn: (c: PoolClient) => Promise<T>, opts: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt < retries && (e?.code === '40001' || e?.code === '40P01')) continue;
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
