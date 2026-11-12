import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Button, H1, Input, Muted, Screen, Spacer, errorMessage, isE164, toE164, useApi } from '@trades/mobile-ui';

export default function Phone() {
  const { mode } = useLocalSearchParams<{ mode: 'login' | 'register' }>();
  const api = useApi();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const register = mode !== 'login';

  async function submit() {
    setError(null);
    const e164 = toE164(phone);
    if (!isE164(e164)) return setError('Enter a valid mobile number');
    if (register && name.trim().length < 2) return setError('Enter your name');
    setBusy(true);
    try {
      const ch = register
        ? await api.auth.registerCustomer({ phone: e164, fullName: name.trim(), email: email.trim() || undefined })
        : await api.auth.requestOtp(e164);
      router.push({ pathname: '/(auth)/verify', params: { phone: e164, devCode: ch.devCode ?? '' } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen footer={<Button title="Send code" onPress={submit} loading={busy} />}>
      <H1>{register ? 'Create your account' : 'Welcome back'}</H1>
      <Spacer h={2} />
      <Muted>We'll text you a 6-digit code to confirm it's you.</Muted>
      <Spacer h={6} />
      {error ? <Banner tone="danger" title={error} /> : null}
      <Input label="Mobile number" prefix="+230" placeholder="5712 3456" keyboardType="phone-pad" autoComplete="tel" value={phone} onChangeText={setPhone} autoFocus />
      {register ? (
        <>
          <Input label="Full name" placeholder="e.g. Aisha Ramjaun" value={name} onChangeText={setName} autoComplete="name" />
          <Input label="Email (optional — for receipts)" placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
        </>
      ) : null}
    </Screen>
  );
}
