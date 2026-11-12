import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Button, H1, Muted, OtpInput, Screen, Spacer, deviceId, deviceName, errorMessage, isRootedDevice, useApi, useSession } from '@trades/mobile-ui';

export default function Verify() {
  const { phone, devCode } = useLocalSearchParams<{ phone: string; devCode?: string }>();
  const api = useApi();
  const { signIn } = useSession();
  const [code, setCode] = useState(devCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(30);

  useEffect(() => {
    const t = setInterval(() => setResendIn(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { if (code.length === 6) verify(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  async function verify() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const pair = await api.auth.verifyOtp({
        phone, code, deviceId: await deviceId(), deviceName: deviceName(), platform: Platform.OS === 'ios' ? 'ios' : 'android', app: 'provider', isRooted: await isRootedDevice(),
      });
      await signIn(pair);
      router.replace('/');
    } catch (e) {
      setError(errorMessage(e)); setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try { await api.auth.requestOtp(phone); setResendIn(30); } catch (e) { setError(errorMessage(e)); }
  }

  return (
    <Screen>
      <H1>Enter your code</H1>
      <Spacer h={2} />
      <Muted>Sent by SMS to {phone}</Muted>
      <Spacer h={8} />
      {error ? <Banner tone="danger" title={error} /> : null}
      <OtpInput value={code} onChange={setCode} />
      <Spacer h={8} />
      <Button title="Verify" onPress={verify} loading={busy} disabled={code.length !== 6} />
      <Spacer h={2} />
      <Button title={resendIn ? `Resend code in ${resendIn}s` : 'Resend code'} variant="ghost" disabled={resendIn > 0} onPress={resend} />
    </Screen>
  );
}
