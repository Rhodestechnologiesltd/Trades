/** Typed environment configuration. Fails fast on missing production secrets. */
const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing required env var ${k}`);
  return v;
};
const bool = (k: string, d = false) => (process.env[k] ?? String(d)).toLowerCase() === 'true';
const int = (k: string, d: number) => Number(process.env[k] ?? d);

export const config = {
  env: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV', 'development') === 'production',
  port: int('PORT', 3000),
  databaseUrl: env('DATABASE_URL', 'postgres://trades:trades@localhost:5432/trades'),
  redisUrl: process.env.REDIS_URL || '',
  publicApiUrl: env('PUBLIC_API_URL', 'http://localhost:3000'),
  corsOrigins: env('CORS_ORIGINS', '*').split(',').map(s => s.trim()),
  jwt: {
    accessSecret: env('JWT_ACCESS_SECRET', 'dev-access-secret'),
    refreshSecret: env('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
    accessTtlSec: int('JWT_ACCESS_TTL_SEC', 900),
    refreshTtlSec: int('JWT_REFRESH_TTL_SEC', 30 * 24 * 3600),
  },
  otpDevEcho: bool('OTP_DEV_ECHO', false),
  dataEncryptionKeyHex: env('DATA_ENCRYPTION_KEY', '0'.repeat(64)),
  payment: {
    gateway: env('PAYMENT_GATEWAY', 'sandbox') as 'sandbox' | 'mips',
    mips: {
      baseUrl: env('MIPS_API_BASE_URL', 'https://api.mips.mu'),
      merchantId: process.env.MIPS_MERCHANT_ID || '',
      entityId: process.env.MIPS_ENTITY_ID || '',
      operatorId: process.env.MIPS_OPERATOR_ID || '',
      operatorPassword: process.env.MIPS_OPERATOR_PASSWORD || '',
      apiUsername: process.env.MIPS_API_USERNAME || '',
      apiPassword: process.env.MIPS_API_PASSWORD || '',
      webhookSecret: process.env.MIPS_WEBHOOK_SECRET || '',
      returnUrl: env('MIPS_RETURN_URL', 'http://localhost:3000/v1/payments/return'),
    },
  },
  disbursementRail: env('DISBURSEMENT_RAIL', 'sandbox') as 'sandbox' | 'manual_bank_file',
  notifications: {
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_FROM || '',
    sendgridKey: process.env.SENDGRID_API_KEY || '',
    emailFrom: env('EMAIL_FROM', 'no-reply@trades.mu'),
  },
  s3: {
    bucket: env('S3_BUCKET', 'trades-media'),
    region: env('S3_REGION', 'eu-west-1'),
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
  kafkaBrokers: (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean),
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
};

export function assertProductionConfig(): void {
  if (!config.isProd) return;
  const bad: string[] = [];
  if (config.jwt.accessSecret.startsWith('dev-') || config.jwt.accessSecret.includes('change-me')) bad.push('JWT_ACCESS_SECRET');
  if (config.jwt.refreshSecret.startsWith('dev-') || config.jwt.refreshSecret.includes('change-me')) bad.push('JWT_REFRESH_SECRET');
  if (/^0+$/.test(config.dataEncryptionKeyHex)) bad.push('DATA_ENCRYPTION_KEY');
  if (config.otpDevEcho) bad.push('OTP_DEV_ECHO must be false');
  if (config.payment.gateway === 'sandbox') bad.push('PAYMENT_GATEWAY must not be sandbox');
  if (config.payment.gateway === 'mips' && !config.payment.mips.webhookSecret) bad.push('MIPS_WEBHOOK_SECRET');
  if (bad.length) throw new Error(`Refusing to start in production with insecure config: ${bad.join(', ')}`);
}
