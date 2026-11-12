import { useQuery } from '@tanstack/react-query';
import { useApi, useSession } from '@trades/mobile-ui';

export function useProviderMe() {
  const api = useApi();
  return useQuery({ queryKey: ['provider-me'], queryFn: () => api.providers.me() });
}

export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: ['categories'], queryFn: () => api.catalog.categories(), staleTime: 3600_000 });
}

export function usePublicConfig() {
  const api = useApi();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['public-config', me?.market?.id], queryFn: () => api.catalog.publicConfig(me?.market?.id), staleTime: 3600_000 });
  return q.data ?? { currency: me?.market?.currency_code ?? 'MUR', customerFeePct: 15, providerCommissionPct: 15, payoutDelayHours: 48, disputeWindowHours: 72, autoApproveHours: 48 };
}
