'use client';
import { FormEvent, useState } from 'react';
import { useSession, msg } from '../../src/client';

const toE164 = (raw: string) => { const d = raw.replace(/[^\d+]/g, ''); return d.startsWith('+') ? d : d.length === 8 ? `+230${d}` : `+${d}`; };

export default function Login() {
  const { api, signIn } = useSession();
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const asProvider = params.get('as') === 'provider';
  const [step, setStep] = useState<'phone' | 'register' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [business, setBusiness] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault(); setError(null); setBusy(true);
    try {
      const p = toE164(phone);
      const ch = step === 'register'
        ? asProvider ? await api.auth.registerProvider({ phone: p, fullName: name, businessName: business || undefined }) : await api.auth.registerCustomer({ phone: p, fullName: name })
        : await api.auth.requestOtp(p);
      if (ch.devCode) setCode(ch.devCode);
      setStep('code');
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const pair = await api.auth.verifyOtp({ phone: toE164(phone), code, deviceId: `web-${navigator.userAgent.slice(0, 60)}`, platform: 'web', app: asProvider ? 'provider' : 'customer' });
      const me = await signIn(pair);
      window.location.href = params.get('next') ?? (me?.user_type === 'provider' ? '/pro' : '/requests');
    } catch (err) {
      const m = msg(err);
      if (/register first/i.test(m)) { setStep('register'); setError('New here? Tell us your name to create an account.'); } else setError(m);
    } finally { setBusy(false); }
  }

  return (
    <main className="container" style={{ maxWidth: 440, padding: '48px 20px' }}>
      <div className="card stack">
        <h1 style={{ margin: 0 }}>{asProvider ? 'Trades Pro sign in' : 'Sign in to Trades'}</h1>
        <p className="muted" style={{ margin: 0 }}>We'll text you a 6-digit code.</p>
        {error ? <div className="banner warning">{error}</div> : null}
        {step !== 'code' ? (
          <form onSubmit={sendCode}>
            <label htmlFor="phone">Mobile number</label>
            <input id="phone" type="tel" autoComplete="tel" placeholder="5712 3456" value={phone} onChange={e => setPhone(e.target.value)} required />
            {step === 'register' ? (
              <>
                <label htmlFor="name">Full name</label><input id="name" value={name} onChange={e => setName(e.target.value)} required minLength={2} />
                {asProvider ? <><label htmlFor="biz">Business name (optional)</label><input id="biz" value={business} onChange={e => setBusiness(e.target.value)} /></> : null}
              </>
            ) : null}
            <div style={{ height: 16 }} />
            <button className="btn block" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
            {step === 'phone' ? <button type="button" className="btn ghost block" onClick={() => setStep('register')}>Create an account</button> : null}
          </form>
        ) : (
          <form onSubmit={verify}>
            <label htmlFor="code">Code sent to {toE164(phone)}</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required />
            <div style={{ height: 16 }} />
            <button className="btn block" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</button>
            <button type="button" className="btn ghost block" onClick={() => setStep('phone')}>Use a different number</button>
          </form>
        )}
        {!asProvider ? <p className="faint">Are you a tradesperson? <a href="/login?as=provider">Sign in to Trades Pro</a></p> : null}
      </div>
    </main>
  );
}
