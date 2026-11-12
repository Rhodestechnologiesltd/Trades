import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Input, Screen, errorMessage, useApi } from '@trades/mobile-ui';
import { useProviderMe } from '../../src/hooks';

export default function Profile() {
  const p = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const [business, setBusiness] = useState('');
  const [bio, setBio] = useState('');
  const [years, setYears] = useState('');
  const [langs, setLangs] = useState('English, French, Kreol');
  const [maxJobs, setMaxJobs] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p) return;
    setBusiness(p.business_name ?? ''); setBio(p.bio ?? ''); setYears(p.years_experience?.toString() ?? '');
    if (p.languages?.length) setLangs(p.languages.join(', ')); setMaxJobs(String(p.max_concurrent_jobs ?? 1));
  }, [p]);

  async function save() {
    if (bio.trim().length < 20) return setError('Write at least a couple of sentences about your work (20+ characters)');
    setBusy(true);
    try {
      await api.providers.updateProfile({
        businessName: business.trim() || undefined, bio: bio.trim(), yearsExperience: years ? Number(years) : undefined,
        languages: langs.split(',').map(s => s.trim()).filter(Boolean), maxConcurrentJobs: Math.min(Math.max(Number(maxJobs) || 1, 1), 20),
      });
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Save" onPress={save} loading={busy} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      <Input label="Business name (optional)" value={business} onChangeText={setBusiness} />
      <Input label="About you" multiline value={bio} onChangeText={setBio} placeholder="Experience, specialities, tools and insurance — customers read this before booking." maxLength={2000} />
      <Input label="Years of experience" keyboardType="number-pad" value={years} onChangeText={setYears} />
      <Input label="Languages" value={langs} onChangeText={setLangs} />
      <Input label="Jobs you can handle at the same time" keyboardType="number-pad" value={maxJobs} onChangeText={setMaxJobs} hint="Teams can take several jobs at once. Solo pros usually choose 1." />
    </Screen>
  );
}
