import { ValidationError } from './errors';

/**
 * Keyset (cursor) pagination over (created_at DESC, id DESC) — stays O(log n) at scale (§E).
 * Cursor is base64url("<iso timestamp>|<uuid>").
 */
export interface Page<T> { items: T[]; nextCursor: string | null }

export function decodeCursor(cursor?: string): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new Error();
    return { ts, id };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

export function encodeCursor(row: { created_at: Date | string; id: string }): string {
  const ts = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return Buffer.from(`${ts}|${row.id}`).toString('base64url');
}

export function clampLimit(limit?: number | string, max = 100, def = 20): number {
  const nn = Number(limit ?? def);
  return Number.isFinite(nn) ? Math.min(Math.max(1, Math.floor(nn)), max) : def;
}

/** Fetch limit+1 rows, return a page. */
export function toPage<T extends { created_at: any; id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
}
