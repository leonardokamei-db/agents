/**
 * Repositório de interações (telemetria do chat). Segue o padrão de `tickets.ts`.
 *
 * INVARIANTE DE TENANCY: `insert` recebe `tenantId`/`agentId` da CONFIGURAÇÃO do
 * agente (nunca do cliente) e SEMPRE grava ambos. Toda agregação de leitura é
 * escopada por `tenant_id` (e, opcionalmente, por `agent_id`) no WHERE — uma query
 * sem esse filtro seria vazamento entre tenants. Sem PII: só metadados.
 */

import { and, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { db } from "../db/client";
import { interactions } from "../db/schema";
import type { InteractionInput } from "../domain";
import { toIso } from "./util";

export interface InteractionSummary {
  total: number;
  handoffCount: number; // transbordos (shouldHandoff = true)
  successNoHandoff: number; // resolvidos sem transbordo
  handoffRate: number; // % de transbordo (0..100)
  successRate: number; // % de sucesso sem transbordo (0..100)
  tokensTotal: number;
  tokensAvg: number; // tokens médios por interação
}

export interface DayPoint {
  day: string; // YYYY-MM-DD (UTC)
  count: number;
  handoffs: number;
  tokens: number;
}

export interface LabelCount {
  label: string;
  count: number;
}

export interface AgentBreakdown {
  agentId: string;
  count: number;
  handoffs: number;
  tokens: number;
}

export interface RecentInteraction {
  id: number;
  agentId: string;
  intent: string;
  source: string;
  agentUsed: string;
  tokensUsed: number;
  shouldHandoff: boolean;
  handoffReason: string;
  toolsCalled: string[];
  ragChunksUsed: number;
  confidence: number;
  createdAt: string;
}

export interface Scope {
  tenantId: string;
  agentId?: string; // opcional: restringe a um agente do tenant
  since: Date; // janela de tempo (created_at >= since)
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

export class InteractionRepository {
  /** Grava a telemetria de uma interação, escopada ao agente/tenant. */
  async insert(tenantId: string, agentId: string, data: InteractionInput): Promise<void> {
    await db.insert(interactions).values({
      agentId,
      tenantId,
      intent: data.intent,
      source: data.source,
      agentUsed: data.agentUsed,
      tokensUsed: data.tokensUsed,
      shouldHandoff: data.shouldHandoff,
      handoffReason: data.handoffReason,
      toolsCalled: data.toolsCalled,
      ragChunksUsed: data.ragChunksUsed,
      confidence: data.confidence,
    });
  }

  private where(scope: Scope): SQL {
    const conds = [
      eq(interactions.tenantId, scope.tenantId),
      gte(interactions.createdAt, scope.since),
    ];
    if (scope.agentId) conds.push(eq(interactions.agentId, scope.agentId));
    return and(...conds)!;
  }

  /** Totais agregados: contagem, transbordo, sucesso sem transbordo, tokens. */
  async summary(scope: Scope): Promise<InteractionSummary> {
    const rows = await db
      .select({
        total: count(),
        handoffCount: sql<number>`count(*) filter (where ${interactions.shouldHandoff})`,
        tokensTotal: sql<number>`coalesce(sum(${interactions.tokensUsed}), 0)`,
      })
      .from(interactions)
      .where(this.where(scope));
    const r = rows[0] ?? { total: 0, handoffCount: 0, tokensTotal: 0 };
    const total = n(r.total);
    const handoffCount = n(r.handoffCount);
    const tokensTotal = n(r.tokensTotal);
    const successNoHandoff = total - handoffCount;
    const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
    return {
      total,
      handoffCount,
      successNoHandoff,
      handoffRate: pct(handoffCount),
      successRate: pct(successNoHandoff),
      tokensTotal,
      tokensAvg: total > 0 ? Math.round(tokensTotal / total) : 0,
    };
  }

  /** Série temporal por dia (UTC) para os gráficos do dashboard. */
  async byDay(scope: Scope): Promise<DayPoint[]> {
    const day = sql<string>`to_char(date_trunc('day', ${interactions.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await db
      .select({
        day,
        count: count(),
        handoffs: sql<number>`count(*) filter (where ${interactions.shouldHandoff})`,
        tokens: sql<number>`coalesce(sum(${interactions.tokensUsed}), 0)`,
      })
      .from(interactions)
      .where(this.where(scope))
      .groupBy(day)
      .orderBy(day);
    return rows.map((r) => ({ day: String(r.day), count: n(r.count), handoffs: n(r.handoffs), tokens: n(r.tokens) }));
  }

  /** Distribuição por intent (faq/order/support/chat...). */
  async byIntent(scope: Scope): Promise<LabelCount[]> {
    const rows = await db
      .select({ label: interactions.intent, count: count() })
      .from(interactions)
      .where(this.where(scope))
      .groupBy(interactions.intent)
      .orderBy(desc(count()));
    return rows.map((r) => ({ label: r.label || "—", count: n(r.count) }));
  }

  /** Distribuição por source (faq_shortcut/llm_rag/support_escalation/...). */
  async bySource(scope: Scope): Promise<LabelCount[]> {
    const rows = await db
      .select({ label: interactions.source, count: count() })
      .from(interactions)
      .where(this.where(scope))
      .groupBy(interactions.source)
      .orderBy(desc(count()));
    return rows.map((r) => ({ label: r.label || "—", count: n(r.count) }));
  }

  /** Quebra por agente do tenant (útil quando nenhum agente está filtrado). */
  async byAgent(scope: Scope): Promise<AgentBreakdown[]> {
    const rows = await db
      .select({
        agentId: interactions.agentId,
        count: count(),
        handoffs: sql<number>`count(*) filter (where ${interactions.shouldHandoff})`,
        tokens: sql<number>`coalesce(sum(${interactions.tokensUsed}), 0)`,
      })
      .from(interactions)
      .where(this.where(scope))
      .groupBy(interactions.agentId)
      .orderBy(desc(count()));
    return rows.map((r) => ({ agentId: r.agentId, count: n(r.count), handoffs: n(r.handoffs), tokens: n(r.tokens) }));
  }

  /** Top ferramentas (skills) chamadas — desaninha o array jsonb tools_called. */
  async topTools(scope: Scope, limit = 10): Promise<LabelCount[]> {
    const result = await db.execute(sql`
      select tool, count(*)::int as count
      from ${interactions}, jsonb_array_elements_text(${interactions.toolsCalled}) as tool
      where ${this.where(scope)}
      group by tool
      order by count desc
      limit ${limit}
    `);
    // postgres-js devolve um RowList (Array); node-postgres devolveria { rows }.
    // Tolera os dois formatos para não acoplar ao driver.
    const raw = result as unknown;
    const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Array<{
      tool: string;
      count: number;
    }>;
    return rows.map((r) => ({ label: String(r.tool), count: n(r.count) }));
  }

  /** Últimas interações (os "logs" do dashboard). */
  async recent(scope: Scope, limit = 50): Promise<RecentInteraction[]> {
    const rows = await db
      .select()
      .from(interactions)
      .where(this.where(scope))
      .orderBy(desc(interactions.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      intent: r.intent,
      source: r.source,
      agentUsed: r.agentUsed,
      tokensUsed: r.tokensUsed,
      shouldHandoff: r.shouldHandoff,
      handoffReason: r.handoffReason,
      toolsCalled: Array.isArray(r.toolsCalled) ? r.toolsCalled : [],
      ragChunksUsed: r.ragChunksUsed,
      confidence: r.confidence,
      createdAt: toIso(r.createdAt),
    }));
  }
}
