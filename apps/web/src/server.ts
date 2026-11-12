import type { Category } from '@trades/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Server-side category fetch for SSR/ISR landing pages (SEO, §B.2). Falls back to empty on API outage. */
export async function getCategories(): Promise<Category[]> {
  try {
    const res = await fetch(`${API}/v1/categories`, { next: { revalidate: 600 } } as RequestInit);
    return res.ok ? ((await res.json()) as Category[]) : [];
  } catch {
    return [];
  }
}
