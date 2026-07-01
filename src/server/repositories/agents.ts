/**
 * Repositório de agentes (porta `app/repositories/agents.py`).
 *
 * INVARIANTE DE TENANCY: resolução por (tenant_id, slug); listagens sempre
 * escopadas por tenant. A PK `id` é opaca e global ({tenant}__{slug}).
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { agents } from "../db/schema";
import type { AgentConfig, ProductMode } from "../domain";
import type { AgentCreateData, AgentUpdateData } from "../schemas";
import { toIso } from "./util";

type AgentRow = typeof agents.$inferSelect;

function toAgentConfig(r: AgentRow): AgentConfig {
  return {
    id: r.id,
    tenantId: r.tenantId,
    slug: r.slug,
    name: r.name,
    systemPrompt: r.systemPrompt ?? "",
    businessRules: r.businessRules ?? "",
    maxTurns: r.maxTurns,
    productMode: r.productMode as ProductMode,
    productApiUrl: r.productApiUrl ?? "",
    productApiKey: r.productApiKey ?? "",
    ragEnabled: r.ragEnabled,
    externalProducts: r.externalProducts,
    skills: Array.isArray(r.skills) ? r.skills : [],
    createdAt: toIso(r.createdAt),
  };
}

export class AgentRepository {
  async getById(agentId: string): Promise<AgentConfig | null> {
    const rows = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    return rows[0] ? toAgentConfig(rows[0]) : null;
  }

  async get(tenantId: string, slug: string): Promise<AgentConfig | null> {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.slug, slug)))
      .limit(1);
    return rows[0] ? toAgentConfig(rows[0]) : null;
  }

  async listForTenant(tenantId: string): Promise<AgentConfig[]> {
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, tenantId))
      .orderBy(asc(agents.createdAt));
    return rows.map(toAgentConfig);
  }

  async listAll(): Promise<AgentConfig[]> {
    const rows = await db.select().from(agents).orderBy(asc(agents.createdAt));
    return rows.map(toAgentConfig);
  }

  async exists(tenantId: string, slug: string): Promise<boolean> {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), eq(agents.slug, slug)))
      .limit(1);
    return rows.length > 0;
  }

  async insert(agentId: string, tenantId: string, slug: string, data: AgentCreateData): Promise<void> {
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      slug,
      name: data.name,
      systemPrompt: data.systemPrompt,
      businessRules: data.businessRules,
      maxTurns: data.maxTurns,
      productMode: data.productMode,
      productApiUrl: data.productApiUrl,
      productApiKey: data.productApiKey,
      ragEnabled: data.ragEnabled,
      externalProducts: data.externalProducts,
      skills: data.skills,
    });
  }

  async update(agentId: string, changes: AgentUpdateData): Promise<void> {
    if (Object.keys(changes).length === 0) return;
    await db
      .update(agents)
      .set(changes as Partial<typeof agents.$inferInsert>)
      .where(eq(agents.id, agentId));
  }

  async delete(agentId: string): Promise<boolean> {
    const deleted = await db.delete(agents).where(eq(agents.id, agentId)).returning({ id: agents.id });
    return deleted.length > 0;
  }
}
