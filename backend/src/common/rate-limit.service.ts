import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { config } from './config';
import { RateLimitedError } from './errors';

/**
 * Fixed-window counters in Redis (§J abuse limits: OTP, quotes, urgent requests, payment attempts).
 * Falls back to an in-memory map when REDIS_URL is unset (single-instance dev only).
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly log = new Logger('RateLimit');
  private redis: any = null;
  private mem = new Map<string, { n: number; exp: number }>();

  constructor() {
    if (config.redisUrl) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis');
      this.redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
      this.redis.on('error', (e: Error) => this.log.warn(`redis: ${e.message}`));
    }
  }

  /** Increments and returns the count in the current window. */
  async hit(bucket: string, windowSec: number): Promise<number> {
    const key = `rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    if (this.redis) {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, windowSec + 5);
      return n;
    }
    const now = Date.now();
    const cur = this.mem.get(key);
    const n = cur && cur.exp > now ? cur.n + 1 : 1;
    this.mem.set(key, { n, exp: now + windowSec * 1000 });
    if (this.mem.size > 50_000) for (const [k, v] of this.mem) if (v.exp < now) this.mem.delete(k);
    return n;
  }

  async enforce(bucket: string, limit: number, windowSec: number, message?: string) {
    if ((await this.hit(bucket, windowSec)) > limit) throw new RateLimitedError(message);
  }

  async onModuleDestroy() { await this.redis?.quit(); }
}
