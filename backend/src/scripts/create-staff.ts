/* Bootstrap the first admin (staff are never self-registered, §I). Prints the TOTP provisioning URI once. */
import { authenticator } from 'otplib';
import { Client } from 'pg';
import { config } from '../common/config';
import { encrypt } from '../common/crypto';
import { AuthService } from '../modules/auth/auth.service';

async function main() {
  const [email, role = 'admin', fullName = 'Platform Admin'] = process.argv.slice(2);
  const password = process.env.STAFF_PASSWORD;
  if (!email || !password) throw new Error('usage: STAFF_PASSWORD=… ts-node src/scripts/create-staff.ts <email> [admin|support|finance] [full name]');
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  const secret = authenticator.generateSecret();
  await client.query(
    `INSERT INTO users (email, full_name, user_type, status, password_hash, mfa_secret_enc, mfa_enabled) VALUES ($1,$2,$3,'active',$4,$5,true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, mfa_secret_enc = EXCLUDED.mfa_secret_enc, mfa_enabled = true`,
    [email.toLowerCase(), fullName, role, await AuthService.hashPassword(password), encrypt(secret).toString('base64')]);
  console.log(`Staff user ${email} (${role}) ready.\nAdd to an authenticator app:\n${authenticator.keyuri(email, 'Trades Admin', secret)}`);
  await client.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
