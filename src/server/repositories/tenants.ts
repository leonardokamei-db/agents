/**
 * Repositórios de tenant/user/membership (porta `app/repositories/tenants.py`).
 * Base do modelo multi-tenant e do RBAC. Todo o SQL dessas tabelas vive aqui.
 */

import { and, asc, count, eq } from "drizzle-orm";

import { db } from "../db/client";
import { memberships, tenants, users } from "../db/schema";
import type { Membership, MemberRole, Tenant, User } from "../domain";
import { toIso } from "./util";

type TenantRow = typeof tenants.$inferSelect;
type UserRow = typeof users.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

function toTenant(r: TenantRow): Tenant {
  return { id: r.id, name: r.name, apiKey: r.apiKey, createdAt: toIso(r.createdAt) };
}
function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name ?? "", apiKey: r.apiKey, createdAt: toIso(r.createdAt) };
}
function toMembership(r: MembershipRow): Membership {
  return { tenantId: r.tenantId, userId: r.userId, role: r.role as MemberRole };
}

export class TenantRepository {
  async get(tenantId: string): Promise<Tenant | null> {
    const rows = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async getByApiKey(apiKey: string): Promise<Tenant | null> {
    const rows = await db.select().from(tenants).where(eq(tenants.apiKey, apiKey)).limit(1);
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async list(): Promise<Tenant[]> {
    const rows = await db.select().from(tenants).orderBy(asc(tenants.createdAt));
    return rows.map(toTenant);
  }

  async exists(tenantId: string): Promise<boolean> {
    const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return rows.length > 0;
  }

  async insert(tenantId: string, name: string, apiKey: string): Promise<void> {
    await db.insert(tenants).values({ id: tenantId, name, apiKey });
  }

  async delete(tenantId: string): Promise<boolean> {
    const deleted = await db.delete(tenants).where(eq(tenants.id, tenantId)).returning({ id: tenants.id });
    return deleted.length > 0;
  }
}

export class UserRepository {
  async get(userId: string): Promise<User | null> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async getByApiKey(apiKey: string): Promise<User | null> {
    const rows = await db.select().from(users).where(eq(users.apiKey, apiKey)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async insert(userId: string, email: string, name: string, apiKey: string): Promise<void> {
    await db.insert(users).values({ id: userId, email, name, apiKey });
  }
}

export class MembershipRepository {
  async get(tenantId: string, userId: string): Promise<Membership | null> {
    const rows = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1);
    return rows[0] ? toMembership(rows[0]) : null;
  }

  async listForTenant(tenantId: string): Promise<Membership[]> {
    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))
      .orderBy(asc(memberships.role), asc(memberships.userId));
    return rows.map(toMembership);
  }

  async upsert(tenantId: string, userId: string, role: string): Promise<void> {
    await db
      .insert(memberships)
      .values({ tenantId, userId, role })
      .onConflictDoUpdate({ target: [memberships.tenantId, memberships.userId], set: { role } });
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    const deleted = await db
      .delete(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
    return deleted.length > 0;
  }

  async countOwners(tenantId: string): Promise<number> {
    const rows = await db
      .select({ c: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner")));
    return Number(rows[0]?.c ?? 0);
  }
}
