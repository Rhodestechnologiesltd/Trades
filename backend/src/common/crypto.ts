import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { config } from './config';

const KEY = Buffer.from(config.dataEncryptionKeyHex, 'hex');
if (KEY.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes hex');

/** AES-256-GCM envelope: [12-byte IV][16-byte tag][ciphertext]. Used for payout details & MFA secrets (§J). */
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmacSha256 = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
export const randomToken = (bytes = 48) => randomBytes(bytes).toString('base64url');
export const otpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
