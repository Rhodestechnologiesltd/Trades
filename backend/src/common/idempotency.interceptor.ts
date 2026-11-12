import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { sha256 } from './crypto';
import { DbService } from './db.service';
import { ConflictError, ValidationError } from './errors';

export const IDEMPOTENT = 'idempotent';
/** Marks a POST as money-moving / state-transitioning: requires an Idempotency-Key header (§E, §F.5). */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

/**
 * Stores (user, key) → response. A retry with the same key replays the stored
 * response instead of re-executing; the same key with a different body is a 422;
 * a concurrent duplicate while the first is in flight is a 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly db: DbService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, ctx.getHandler())) return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const key: string | undefined = req.headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 128) throw new ValidationError('Idempotency-Key header (8–128 chars) is required for this operation');
    const userId = req.actor?.userId ?? '00000000-0000-0000-0000-000000000000';
    const hash = sha256(JSON.stringify({ m: req.method, p: req.route?.path ?? req.url, b: req.body ?? null, q: req.params ?? null }));

    return from(this.claim(userId, key, req.method, req.originalUrl ?? req.url, hash)).pipe(
      mergeMap(existing => {
        if (existing) {
          res.status(existing.status_code);
          res.setHeader('Idempotent-Replay', 'true');
          return of(existing.response_body);
        }
        return next.handle().pipe(
          mergeMap(body => from(this.store(userId, key, res.statusCode ?? 200, body)).pipe(mergeMap(() => of(body)))),
          catchError(err => from(this.release(userId, key)).pipe(mergeMap(() => { throw err; }))),
        );
      }),
    );
  }

  private async claim(userId: string, key: string, method: string, path: string, hash: string) {
    const inserted = await this.db.one(
      `INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, locked_until)
       VALUES ($1,$2,$3,$4,$5, now() + interval '60 seconds')
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [key, userId, method, path, hash]);
    if (inserted) return null;
    const row = await this.db.one(`SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [userId, key]);
    if (!row) return null;
    if (row.request_hash !== hash) throw new ValidationError('Idempotency-Key was already used with a different request');
    if (row.status_code === null) throw new ConflictError('A request with this Idempotency-Key is still in progress', 'idempotency_in_progress');
    return row;
  }

  private async store(userId: string, key: string, status: number, body: unknown) {
    await this.db.pool.query(
      `UPDATE idempotency_keys SET status_code = $3, response_body = $4, locked_until = NULL WHERE user_id = $1 AND key = $2`,
      [userId, key, status, JSON.stringify(body ?? null)]);
  }

  /** Failed requests release the key so the client can retry the same operation. */
  private async release(userId: string, key: string) {
    await this.db.pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status_code IS NULL`, [userId, key]);
  }
}
