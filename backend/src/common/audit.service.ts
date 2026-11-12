import { Injectable } from '@nestjs/common';
import { Actor } from './auth';
import { Queryable } from './db.service';

/** Append-only audit trail for every state transition and privileged action (§J). */
@Injectable()
export class AuditService {
  async log(q: Queryable, actor: Actor, action: string, entityType: string, entityId: string | null,
            before: unknown = null, after: unknown = null, reason?: string): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_state, after_state, reason, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [actor.userId, actor.type, action, entityType, entityId, before ? JSON.stringify(before) : null,
       after ? JSON.stringify(after) : null, reason ?? null, actor.ip ?? null, actor.userAgent ?? null],
    );
  }

  /** Who viewed whose exact address / location history / KYC document (§G.7, §J). */
  async sensitiveRead(q: Queryable, actor: Actor, resource: string, subjectUserId: string | null, resourceId: string | null, purpose?: string) {
    await q.query(
      `INSERT INTO sensitive_access_logs (actor_user_id, actor_type, subject_user_id, resource, resource_id, purpose) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor.userId, actor.type, subjectUserId, resource, resourceId, purpose ?? null],
    );
  }
}
