import { Injectable } from '@nestjs/common';
import { Actor } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { DbService } from '../../common/db.service';
import { NotFoundError, ValidationError } from '../../common/errors';

export interface CategoryNode {
  id: string; slug: string; name: string; icon: string | null; parentId: string | null;
  requiresLicense: boolean; requiresBackgroundCheck: boolean; urgencyAllowed: boolean;
  averageJobDurationMin: number; instantAcceptPrice: string | null; priceFloor: string | null; priceCeiling: string | null;
  children: CategoryNode[];
}

const CATEGORY_COLUMNS = ['parent_id', 'slug', 'name', 'description', 'icon', 'sort_order', 'requires_license', 'requires_background_check',
  'urgency_allowed', 'average_job_duration_min', 'customer_fee_bps', 'provider_commission_bps', 'price_floor', 'price_ceiling',
  'instant_accept_price', 'max_negotiation_rounds', 'is_active'] as const;

/** Admin-managed hierarchical taxonomy (§A.2) — new trades need no deploy. */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async tree(includeInactive = false): Promise<CategoryNode[]> {
    const rows = await this.db.many(
      `SELECT * FROM service_categories WHERE ($1 OR is_active) ORDER BY sort_order, name`, [includeInactive]);
    const byId = new Map<string, CategoryNode>();
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id, slug: r.slug, name: r.name, icon: r.icon, parentId: r.parent_id,
        requiresLicense: r.requires_license, requiresBackgroundCheck: r.requires_background_check, urgencyAllowed: r.urgency_allowed,
        averageJobDurationMin: r.average_job_duration_min, instantAcceptPrice: r.instant_accept_price,
        priceFloor: r.price_floor, priceCeiling: r.price_ceiling, children: [],
        ...(includeInactive ? { isActive: r.is_active, customerFeeBps: r.customer_fee_bps, providerCommissionBps: r.provider_commission_bps, maxNegotiationRounds: r.max_negotiation_rounds } : {}),
      } as CategoryNode);
    }
    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
      else if (!node.parentId) roots.push(node);
    }
    return roots;
  }

  async get(id: string) {
    const c = await this.db.one(`SELECT * FROM service_categories WHERE id = $1`, [id]);
    if (!c) throw new NotFoundError('Category not found');
    return c;
  }

  async priceBands(categoryId: string, marketId: string) {
    return this.db.many(`SELECT sku_name, suggested_min, suggested_max, currency_code FROM category_price_bands WHERE category_id = $1 AND market_id = $2 ORDER BY sku_name`, [categoryId, marketId]);
  }

  async upsert(actor: Actor, id: string | null, data: Record<string, unknown>, reason: string) {
    const entries = Object.entries(data).filter(([k]) => (CATEGORY_COLUMNS as readonly string[]).includes(k));
    if (!entries.length) throw new ValidationError('No valid category fields supplied');
    return this.db.tx(async c => {
      let row;
      if (id) {
        const before = await this.db.oneOrFail(`SELECT * FROM service_categories WHERE id = $1 FOR UPDATE`, [id], c, 'Category');
        const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        row = await this.db.one(`UPDATE service_categories SET ${sets} WHERE id = $1 RETURNING *`, [id, ...entries.map(e => e[1])], c);
        await this.audit.log(c, actor, 'category.update', 'service_category', id, before, row, reason);
      } else {
        const cols = entries.map(e => e[0]).join(', ');
        const vals = entries.map((_, i) => `$${i + 1}`).join(', ');
        row = await this.db.one(`INSERT INTO service_categories (${cols}) VALUES (${vals}) RETURNING *`, entries.map(e => e[1]), c);
        await this.audit.log(c, actor, 'category.create', 'service_category', row!.id, null, row, reason);
      }
      return row;
    });
  }

  markets(activeOnly = true) {
    return this.db.many(`SELECT * FROM markets WHERE ($1 = false OR is_active) ORDER BY country_code, city`, [activeOnly]);
  }

  async updateMarket(actor: Actor, id: string, data: { customerFeeBps?: number | null; providerCommissionBps?: number | null; isActive?: boolean; maxDispatchRadiusM?: number }, reason: string) {
    return this.db.tx(async c => {
      const before = await this.db.oneOrFail(`SELECT * FROM markets WHERE id = $1 FOR UPDATE`, [id], c, 'Market');
      const row = await this.db.one(
        `UPDATE markets SET customer_fee_bps = $2, provider_commission_bps = $3, is_active = COALESCE($4, is_active),
                max_dispatch_radius_m = COALESCE($5, max_dispatch_radius_m) WHERE id = $1 RETURNING *`,
        [id, data.customerFeeBps === undefined ? before.customer_fee_bps : data.customerFeeBps,
         data.providerCommissionBps === undefined ? before.provider_commission_bps : data.providerCommissionBps,
         data.isActive ?? null, data.maxDispatchRadiusM ?? null], c);
      await this.audit.log(c, actor, 'market.update', 'market', id, before, row, reason);
      return row;
    });
  }

  async createMarket(actor: Actor, d: { countryCode: string; city: string; currencyCode: string; timezone: string; centerLat: number; centerLng: number }, reason: string) {
    return this.db.tx(async c => {
      const row = await this.db.one(
        `INSERT INTO markets (country_code, city, currency_code, timezone, center_lat, center_lng, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`, [d.countryCode, d.city, d.currencyCode, d.timezone, d.centerLat, d.centerLng], c);
      await this.audit.log(c, actor, 'market.create', 'market', row!.id, null, row, reason);
      return row;
    });
  }
}
