import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { randomUUID } from 'crypto';
import { DEFAULT_ABUSE_LIMITS } from '@trades/domain';
import { Actor, Role, signAccessToken } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { config } from '../../common/config';
import { decrypt, otpCode, randomToken, safeEqual, sha256 } from '../../common/crypto';
import { DbService, Queryable } from '../../common/db.service';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../common/errors';
import { PlatformConfigService } from '../../common/platform-config.service';
import { RateLimitService } from '../../common/rate-limit.service';
import { SmsChannel } from '../notifications/channels';
import { RegisterCustomerDto, RegisterProviderDto, VerifyOtpDto } from './auth.dto';

const OTP_TTL_SEC = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const DEFAULT_MARKET = '00000000-0000-0000-0000-00000000a001';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; type: Role; fullName: string; status: string; marketId: string | null };
  newDevice?: boolean;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly cfg: PlatformConfigService,
    private readonly sms: SmsChannel,
  ) {}

  /* ───────────── registration ───────────── */

  async registerCustomer(dto: RegisterCustomerDto, ip?: string) {
    await this.db.tx(async c => {
      const existing = await this.db.one(`SELECT id, user_type FROM users WHERE phone_number = $1`, [dto.phone], c);
      if (existing) {
        if (existing.user_type !== 'customer') throw new ConflictError('This phone number is registered to a different account type');
        return;
      }
      const marketId = await this.marketFor(c);
      const u = await this.db.one(
        `INSERT INTO users (phone_number, email, full_name, user_type, status, market_id, locale)
         VALUES ($1,$2,$3,'customer','active',$4,$5) RETURNING id`,
        [dto.phone, dto.email?.toLowerCase() ?? null, dto.fullName.trim(), marketId, dto.locale ?? 'en'], c);
      await c.query(`INSERT INTO customers (id) VALUES ($1)`, [u!.id]);
      await this.audit.log(c, { userId: u!.id, type: 'customer', ip }, 'user.register', 'user', u!.id, null, { type: 'customer' });
    });
    return this.requestOtp(dto.phone, 'register', ip);
  }

  async registerProvider(dto: RegisterProviderDto, ip?: string) {
    await this.db.tx(async c => {
      const existing = await this.db.one(`SELECT id, user_type FROM users WHERE phone_number = $1`, [dto.phone], c);
      if (existing) {
        if (existing.user_type !== 'provider') throw new ConflictError('This phone number is registered to a different account type');
        return;
      }
      const marketId = await this.marketFor(c);
      const u = await this.db.one(
        `INSERT INTO users (phone_number, email, full_name, user_type, status, market_id, locale)
         VALUES ($1,$2,$3,'provider','pending_verification',$4,$5) RETURNING id`,
        [dto.phone, dto.email?.toLowerCase() ?? null, dto.fullName.trim(), marketId, dto.locale ?? 'en'], c);
      await c.query(`INSERT INTO providers (id, business_name) VALUES ($1,$2)`, [u!.id, dto.businessName ?? null]);
      await c.query(`INSERT INTO provider_profiles (provider_id) VALUES ($1)`, [u!.id]);
      await this.audit.log(c, { userId: u!.id, type: 'provider', ip }, 'user.register', 'user', u!.id, null, { type: 'provider' });
    });
    return this.requestOtp(dto.phone, 'register', ip);
  }

  private async marketFor(q: Queryable): Promise<string> {
    // Single launch market; multi-market: resolve from device location / phone country code.
    const m = await this.db.one(`SELECT id FROM markets WHERE is_active ORDER BY created_at LIMIT 1`, [], q);
    return m?.id ?? DEFAULT_MARKET;
  }

  /* ───────────── OTP ───────────── */

  async requestOtp(destination: string, purpose: 'login' | 'register' | 'step_up' | 'payout_account_change', ip?: string) {
    const abuse = await this.cfg.abuse().catch(() => DEFAULT_ABUSE_LIMITS);
    await this.limits.enforce(`otp:${destination}`, abuse.maxOtpRequestsPerPhonePerHour, 3600, 'Too many codes requested. Try again later.');
    if (ip) await this.limits.enforce(`otp-ip:${ip}`, 30, 3600);
    const code = otpCode();
    const id = randomUUID();
    await this.db.pool.query(
      `INSERT INTO otp_challenges (id, destination, purpose, code_hash, expires_at, ip_address)
       VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6)`,
      [id, destination, purpose, sha256(`${id}:${code}`), OTP_TTL_SEC, ip ?? null]);
    if (!config.otpDevEcho) {
      await this.sms.send(destination, `Your Trades verification code is ${code}. It expires in 5 minutes. Never share this code.`);
    }
    return { challengeId: id, expiresInSec: OTP_TTL_SEC, ...(config.otpDevEcho ? { devCode: code } : {}) };
  }

  /** Consumes the newest valid OTP for a destination. Throws on mismatch (counts attempts). */
  async consumeOtp(destination: string, code: string, purposes: string[], q: Queryable = this.db.pool): Promise<void> {
    const ch = await this.db.one(
      `SELECT * FROM otp_challenges WHERE destination = $1 AND purpose = ANY($2) AND consumed_at IS NULL
         AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [destination, purposes], q);
    if (!ch) throw new UnauthorizedError('Code expired or not found. Request a new code.', 'otp_invalid');
    if (ch.attempts >= OTP_MAX_ATTEMPTS) throw new UnauthorizedError('Too many incorrect attempts. Request a new code.', 'otp_locked');
    if (!safeEqual(ch.code_hash, sha256(`${ch.id}:${code}`))) {
      await q.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [ch.id]);
      throw new UnauthorizedError('Incorrect code', 'otp_invalid');
    }
    await q.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [ch.id]);
  }

  async verifyOtp(dto: VerifyOtpDto, ip?: string, userAgent?: string): Promise<TokenPair> {
    // Consume in its own committed transaction so failed attempts are counted even when we throw.
    await this.db.tx(c => this.consumeOtp(dto.phone, dto.code, ['login', 'register'], c));
    return this.db.tx(async c => {
      const user = await this.db.one(`SELECT * FROM users WHERE phone_number = $1 AND deleted_at IS NULL FOR UPDATE`, [dto.phone], c);
      if (!user) throw new NotFoundError('No account for this number. Please register first.');
      if (dto.app && dto.app !== user.user_type) throw new ForbiddenError(`This number is registered as a ${user.user_type}. Use the ${user.user_type} app.`);
      if (user.status === 'banned') throw new ForbiddenError('This account has been banned');
      if (user.status === 'suspended') throw new ForbiddenError('This account is suspended. Contact support.');
      await c.query(`UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, now()), last_login_at = now() WHERE id = $1`, [user.id]);
      const newDevice = await this.trackDevice(c, user.id, dto.deviceId, !!dto.isRooted);
      const pair = await this.createSession(c, user, { deviceId: dto.deviceId, deviceName: dto.deviceName, platform: dto.platform, ip, userAgent, mfa: false });
      await this.audit.log(c, { userId: user.id, type: user.user_type, ip, userAgent }, 'auth.login', 'user', user.id, null, { deviceId: dto.deviceId, newDevice });
      return { ...pair, newDevice };
    });
  }

  private async trackDevice(q: Queryable, userId: string, deviceId: string, rooted: boolean): Promise<boolean> {
    const r = await this.db.one(
      `INSERT INTO known_devices (user_id, device_id, is_rooted) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = now(), is_rooted = known_devices.is_rooted OR EXCLUDED.is_rooted
       RETURNING (xmax = 0) AS inserted`, [userId, deviceId, rooted], q);
    const known = await this.db.one(`SELECT count(*)::int AS n FROM known_devices WHERE user_id = $1`, [userId], q);
    return !!r?.inserted && known!.n > 1;
  }

  /* ───────────── sessions & refresh rotation ───────────── */

  private async createSession(q: Queryable, user: any, s: { deviceId?: string; deviceName?: string; platform?: string; ip?: string; userAgent?: string; mfa: boolean; familyId?: string }): Promise<TokenPair> {
    const refreshToken = randomToken();
    const sessionId = randomUUID();
    await q.query(
      `INSERT INTO auth_sessions (id, user_id, family_id, refresh_token_hash, device_id, device_name, platform, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(secs => $10))`,
      [sessionId, user.id, s.familyId ?? randomUUID(), sha256(refreshToken), s.deviceId ?? null, s.deviceName ?? null,
       s.platform ?? null, s.ip ?? null, s.userAgent ?? null, config.jwt.refreshTtlSec]);
    const accessToken = signAccessToken({ sub: user.id, typ: user.user_type, sid: sessionId, mkt: user.market_id, mfa: s.mfa });
    return {
      accessToken, refreshToken, expiresIn: config.jwt.accessTtlSec,
      user: { id: user.id, type: user.user_type, fullName: user.full_name, status: user.status, marketId: user.market_id },
    };
  }

  /**
   * Refresh-token rotation with reuse detection (§J): presenting an already-rotated
   * token means it was stolen → the whole token family is revoked.
   */
  async refresh(refreshToken: string, ip?: string, userAgent?: string): Promise<TokenPair> {
    return this.db.tx(async c => {
      const s = await this.db.one(`SELECT * FROM auth_sessions WHERE refresh_token_hash = $1 FOR UPDATE`, [sha256(refreshToken)], c);
      if (!s) throw new UnauthorizedError('Invalid refresh token', 'invalid_token');
      if (s.rotated_at || s.revoked_at) {
        await c.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse' WHERE family_id = $1 AND revoked_at IS NULL`, [s.family_id]);
        await this.audit.log(c, { userId: s.user_id, type: 'system', ip }, 'auth.refresh_reuse_detected', 'auth_session', s.id);
        this.log.warn(`Refresh token reuse detected for user ${s.user_id} — family ${s.family_id} revoked`);
        throw new UnauthorizedError('Session revoked. Please sign in again.', 'session_revoked');
      }
      if (new Date(s.expires_at) < new Date()) throw new UnauthorizedError('Session expired', 'session_expired');
      const user = await this.db.one(`SELECT * FROM users WHERE id = $1`, [s.user_id], c);
      if (!user || ['banned', 'suspended'].includes(user.status)) throw new ForbiddenError('Account unavailable');
      await c.query(`UPDATE auth_sessions SET rotated_at = now() WHERE id = $1`, [s.id]);
      const mfa = ['admin', 'support', 'finance'].includes(user.user_type);
      return this.createSession(c, user, { deviceId: s.device_id, deviceName: s.device_name, platform: s.platform, ip, userAgent, mfa, familyId: s.family_id });
    });
  }

  async logout(actor: Actor) {
    const s = await this.db.one(`SELECT family_id FROM auth_sessions WHERE id = $1`, [actor.sessionId]);
    if (s) await this.db.pool.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE family_id = $1 AND revoked_at IS NULL`, [s.family_id]);
    return { ok: true };
  }

  async listSessions(actor: Actor) {
    return this.db.many(
      `SELECT DISTINCT ON (family_id) family_id AS id, device_name, platform, ip_address, created_at, last_seen_at,
              (family_id = (SELECT family_id FROM auth_sessions WHERE id = $2)) AS current
         FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()
        ORDER BY family_id, created_at DESC`, [actor.userId, actor.sessionId]);
  }

  async revokeSession(actor: Actor, familyId: string) {
    const r = await this.db.pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [familyId, actor.userId]);
    if (!r.rowCount) throw new NotFoundError('Session not found');
    return { ok: true };
  }

  /* ───────────── staff (admin / support / finance) ───────────── */

  async staffLogin(email: string, password: string, totp: string, deviceId: string, ip?: string, userAgent?: string): Promise<TokenPair> {
    await this.limits.enforce(`staff-login:${email.toLowerCase()}`, 10, 900, 'Too many login attempts');
    return this.db.tx(async c => {
      const user = await this.db.one(`SELECT * FROM users WHERE email = $1 AND user_type IN ('admin','support','finance') AND deleted_at IS NULL`, [email.toLowerCase()], c);
      const ok = user?.password_hash && (await bcrypt.compare(password, user.password_hash));
      if (!user || !ok) throw new UnauthorizedError('Invalid credentials');
      if (user.status !== 'active') throw new ForbiddenError('Account disabled');
      if (!user.mfa_enabled || !user.mfa_secret_enc) throw new ForbiddenError('MFA is not set up for this account. Ask an admin to provision it.');
      const secret = decrypt(Buffer.from(user.mfa_secret_enc, 'base64'));
      if (!authenticator.check(totp, secret)) {
        await this.audit.log(c, { userId: user.id, type: user.user_type, ip }, 'auth.staff_mfa_failed', 'user', user.id);
        throw new UnauthorizedError('Invalid MFA code');
      }
      await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
      await this.audit.log(c, { userId: user.id, type: user.user_type, ip, userAgent }, 'auth.staff_login', 'user', user.id);
      return this.createSession(c, user, { deviceId, platform: 'admin', ip, userAgent, mfa: true });
    });
  }

  static async hashPassword(pw: string) {
    if (pw.length < 12) throw new ValidationError('Staff passwords must be at least 12 characters');
    return bcrypt.hash(pw, 12);
  }

  /* ───────────── step-up verification (payout account changes etc.) ───────────── */

  async startStepUp(actor: Actor) {
    const u = await this.db.oneOrFail(`SELECT phone_number FROM users WHERE id = $1`, [actor.userId]);
    return this.requestOtp(u.phone_number, 'step_up', actor.ip);
  }

  async completeStepUp(actor: Actor, code: string, q: Queryable) {
    const u = await this.db.oneOrFail(`SELECT phone_number FROM users WHERE id = $1`, [actor.userId], q);
    await this.consumeOtp(u.phone_number, code, ['step_up'], q);
  }
}
