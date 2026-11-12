import { Injectable } from '@nestjs/common';
import {
  AbuseLimits, CancellationPolicy, DEFAULT_ABUSE_LIMITS, DEFAULT_CANCELLATION, DEFAULT_POLICIES, DEFAULT_TIMING, DEFAULT_WEIGHTS,
  DispatchPolicy, FeeConfig, PLATFORM_DEFAULT_FEES, RankingWeights, RequestMode, TimingPolicy, resolveFeeConfig,
} from '@trades/domain';
import { Actor } from './auth';
import { AuditService } from './audit.service';
import { DbService, Queryable } from './db.service';

/** Admin-managed configuration with a short in-memory cache (§A: fee config, policies). */
@Injectable()
export class PlatformConfigService {
  private cache = new Map<string, { value: any; at: number }>();
  private readonly ttlMs = 30_000;

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const row = await this.db.one<{ value: any }>(`SELECT value FROM platform_config WHERE key = $1`, [key]);
    const value = row ? (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback) ? { ...fallback, ...row.value } : row.value) : fallback;
    this.cache.set(key, { value, at: Date.now() });
    return value as T;
  }

  async set(key: string, value: unknown, actor: Actor, reason: string, q: Queryable = this.db.pool) {
    const before = await this.db.one(`SELECT value FROM platform_config WHERE key = $1`, [key], q);
    await q.query(
      `INSERT INTO platform_config (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor.userId]);
    await this.audit.log(q, actor, 'platform_config.update', 'platform_config', null, { key, ...before }, { key, value }, reason);
    this.cache.delete(key);
  }

  all() {
    return this.db.many(`SELECT key, value, description, updated_by, updated_at FROM platform_config ORDER BY key`);
  }

  timing(): Promise<TimingPolicy> { return this.get('timing', DEFAULT_TIMING); }
  abuse(): Promise<AbuseLimits> { return this.get('abuse', DEFAULT_ABUSE_LIMITS); }
  cancellation(): Promise<CancellationPolicy> { return this.get('cancellation', DEFAULT_CANCELLATION); }
  async maxNegotiationRounds(): Promise<number> { return (await this.get('negotiation', { maxRounds: 3 })).maxRounds; }

  async dispatchPolicy(mode: RequestMode): Promise<DispatchPolicy> {
    const overrides = await this.get<Record<string, Partial<DispatchPolicy>>>('dispatch', {});
    return { ...DEFAULT_POLICIES[mode], ...(overrides[mode] ?? {}) };
  }

  async rankingWeights(mode: RequestMode): Promise<RankingWeights> {
    const overrides = await this.get<Record<string, Partial<RankingWeights>>>('ranking', {});
    return { ...DEFAULT_WEIGHTS[mode], ...(overrides[mode] ?? {}) };
  }

  /** Resolves fees most-specific-first: category (or its parent) > market > platform. */
  async feesFor(categoryId: string, marketId: string, q: Queryable = this.db.pool): Promise<FeeConfig> {
    const platform = await this.get<FeeConfig>('fees', PLATFORM_DEFAULT_FEES);
    const row = await this.db.one(
      `SELECT m.customer_fee_bps AS m_fee, m.provider_commission_bps AS m_comm,
              COALESCE(c.customer_fee_bps, pc.customer_fee_bps) AS c_fee,
              COALESCE(c.provider_commission_bps, pc.provider_commission_bps) AS c_comm
         FROM service_categories c LEFT JOIN service_categories pc ON pc.id = c.parent_id, markets m
        WHERE c.id = $1 AND m.id = $2`, [categoryId, marketId], q);
    const nn = (v: any) => (v === null || v === undefined ? undefined : Number(v));
    return resolveFeeConfig(platform, {
      market: row ? { customerFeeBps: nn(row.m_fee), providerCommissionBps: nn(row.m_comm) } : null,
      category: row ? { customerFeeBps: nn(row.c_fee), providerCommissionBps: nn(row.c_comm) } : null,
    });
  }
}
