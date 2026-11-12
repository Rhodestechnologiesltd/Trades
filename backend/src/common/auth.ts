import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import type { ActorType } from '@trades/domain';
import { config } from './config';
import { ForbiddenError, UnauthorizedError } from './errors';

export type Role = 'customer' | 'provider' | 'admin' | 'support' | 'finance';
export const STAFF_ROLES: Role[] = ['admin', 'support', 'finance'];

/** The authenticated principal. `system` is used by the scheduler and webhooks. */
export interface Actor {
  userId: string | null;
  type: ActorType;
  sessionId?: string;
  marketId?: string | null;
  mfa?: boolean;
  ip?: string;
  userAgent?: string;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({ userId: null, type: 'system' });

export interface AccessTokenClaims {
  sub: string;
  typ: Role;
  sid: string;
  mkt?: string | null;
  mfa?: boolean;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
/** Restrict an endpoint to the given roles. RBAC is enforced server-side only (§I). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => ctx.switchToHttp().getRequest().actor);

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtlSec, issuer: 'trades-api', audience: 'trades' });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, config.jwt.accessSecret, { issuer: 'trades-api', audience: 'trades' }) as AccessTokenClaims;
  } catch (e: any) {
    throw new UnauthorizedError(e?.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token', e?.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token');
  }
}

/**
 * Global guard: authenticates the bearer token, then enforces @Roles.
 * Staff roles additionally require an MFA-verified session (§I, §J).
 * Resource-level ownership is re-checked inside each service (defence in depth).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const header: string | undefined = req.headers?.authorization;
    if (header?.startsWith('Bearer ')) {
      const claims = verifyAccessToken(header.slice(7));
      req.actor = {
        userId: claims.sub, type: claims.typ, sessionId: claims.sid, marketId: claims.mkt ?? null, mfa: !!claims.mfa,
        ip: req.ip, userAgent: req.headers['user-agent'],
      } satisfies Actor;
    }
    if (isPublic) return true;
    if (!req.actor) throw new UnauthorizedError('Authentication required');

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(req.actor.type)) throw new ForbiddenError('Your role cannot perform this action');
    if (STAFF_ROLES.includes(req.actor.type) && !req.actor.mfa) throw new ForbiddenError('Staff accounts must complete MFA');
    return true;
  }
}

export function isStaff(a: Actor): boolean {
  return STAFF_ROLES.includes(a.type as Role);
}

export function assertSelfOrStaff(a: Actor, ownerUserId: string): void {
  if (a.userId !== ownerUserId && !isStaff(a) && a.type !== 'system') throw new ForbiddenError();
}
