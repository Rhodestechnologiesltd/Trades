import { useState } from 'react';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, H2, Input, Muted, OtpInput, Screen, Segmented, Spacer, errorMessage, useApi } from '@trades/mobile-ui';
import { useProviderMe } from '../../src/hooks';

/** Payout account changes require a fresh SMS code and start a 24h cooling-off period (§J account-takeover defence). */
export default function Payout() {
  const me = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const [method, setMethod] = useState<'bank_transfer' | 'mobile_wallet'>('bank_transfer');
  const [holder, setHolder] = useState(me?.full_name ?? '');
  const [bank, setBank] = useState('');
  const [account, setAccount] = useState('');
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    if (!holder.trim() || account.replace(/\s/g, '').length < 6) return setError('Enter the account holder and account number / IBAN');
    setBusy(true); setError(null);
    try { const ch = await api.auth.startStepUp(); if (ch.devCode) setCode(ch.devCode); setStep('otp'); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(null);
    try {
      await api.providers.setPayoutAccount({ method, accountHolderName: holder.trim(), bankName: bank.trim() || undefined, accountNumber: account.replace(/\s/g, ''), stepUpCode: code });
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); setCode(''); } finally { setBusy(false); }
  }

  return (
    <Screen footer={step === 'form' ? <Button title="Continue" onPress={requestCode} loading={busy} /> : <Button title="Confirm account" onPress={save} loading={busy} disabled={code.length !== 6} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      {me?.payoutAccount ? <Banner tone="info" title={`Current: ${me.payoutAccount.bank_name ?? me.payoutAccount.method} •••• ${me.payoutAccount.account_last4}`} body="Changing it pauses payouts to the new account for 24 hours for your security." /> : null}
      {step === 'form' ? (
        <>
          <Segmented value={method} onChange={setMethod} options={[{ value: 'bank_transfer', label: 'Bank account' }, { value: 'mobile_wallet', label: 'Mobile wallet' }]} />
          <Spacer h={4} />
          <Input label="Account holder name" value={holder} onChangeText={setHolder} />
          {method === 'bank_transfer' ? <Input label="Bank" value={bank} onChangeText={setBank} placeholder="MCB, SBM, Absa, MauBank…" /> : <Input label="Wallet provider" value={bank} onChangeText={setBank} placeholder="e.g. Juice, my.t money" />}
          <Input label={method === 'bank_transfer' ? 'IBAN / account number' : 'Wallet phone number'} value={account} onChangeText={setAccount} autoCapitalize="characters" />
          <Muted>The account must be in your name or your registered business's name.</Muted>
        </>
      ) : (
        <>
          <H2>Confirm it's you</H2>
          <Muted>Enter the code we just sent by SMS.</Muted>
          <Spacer h={5} />
          <OtpInput value={code} onChange={setCode} />
        </>
      )}
    </Screen>
  );
}
