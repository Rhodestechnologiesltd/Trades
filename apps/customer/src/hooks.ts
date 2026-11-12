import { useQuery } from '@tanstack/react-query';
import type { Category } from '@trades/shared';
import { useApi, useSession } from '@trades/mobile-ui';

export function useCategories() {
  const api = useApi();
  return useQuery({ queryKey: ['categories'], queryFn: () => api.catalog.categories(), staleTime: 3600_000 });
}

export function findCategory(tree: Category[] | undefined, id: string | undefined): Category | undefined {
  if (!tree || !id) return undefined;
  for (const c of tree) {
    if (c.id === id) return c;
    const sub = c.children.find(x => x.id === id);
    if (sub) return sub;
  }
  return undefined;
}

export function useAddresses() {
  const api = useApi();
  return useQuery({ queryKey: ['addresses'], queryFn: () => api.addresses.list() });
}

/** Fee %, currency and policy windows for display copy (server is authoritative). */
export function usePublicConfig() {
  const api = useApi();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['public-config', me?.market?.id], queryFn: () => api.catalog.publicConfig(me?.market?.id), staleTime: 3600_000 });
  return q.data ?? { currency: me?.market?.currency_code ?? 'MUR', customerFeePct: 15, providerCommissionPct: 15, payoutDelayHours: 48, disputeWindowHours: 72, autoApproveHours: 48 };
}
