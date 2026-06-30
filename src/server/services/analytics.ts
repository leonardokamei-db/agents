/**
 * AnalyticsService (time de dados): grava a telemetria de cada interação do chat e
 * monta o dashboard (% de transbordo, sucesso sem transbordo, tokens, intents,
 * skills mais usadas, série por dia e logs recentes).
 *
 * Gravação BEST-EFFORT: `recordFromResult` NUNCA lança — uma falha de telemetria
 * não pode derrubar o chat (que já degrada para handoff em qualquer erro). O
 * detalhe fica só no log.
 *
 * Isolamento: tenantId/agentId vêm SEMPRE da configuração do agente (server-side),
 * nunca do cliente; toda leitura é escopada por tenant no repositório.
 */

import type { AgentConfig, InteractionInput } from "../domain";
import { getLogger } from "../logging";
import type { ProcessResult } from "../orchestrator";
import {
  type AgentBreakdown,
  type DayPoint,
  InteractionRepository,
  type InteractionSummary,
  type LabelCount,
  type RecentInteraction,
} from "../repositories/interactions";

const log = getLogger("blip-agent.services.analytics");

export interface DashboardRange {
  days: number;
  since: string;
  agentSlug: string | null;
}

export interface Dashboard {
  range: DashboardRange;
  summary: InteractionSummary;
  byDay: DayPoint[];
  byIntent: LabelCount[];
  bySource: LabelCount[];
  byAgent: Array<AgentBreakdown & { slug: string }>;
  topTools: LabelCount[];
  recent: Array<RecentInteraction & { slug: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deriva o slug a partir da PK opaca `{tenant}__{slug}`. */
function slugOf(agentId: string, tenantId: string): string {
  const prefix = `${tenantId}__`;
  return agentId.startsWith(prefix) ? agentId.slice(prefix.length) : agentId;
}

export class AnalyticsService {
  constructor(private readonly repo: InteractionRepository = new InteractionRepository()) {}

  /** Mapeia a saída do Orchestrator para a telemetria persistida (sem PII). */
  private static toInput(result: ProcessResult): InteractionInput {
    return {
      intent: result.intent,
      source: result.source,
      agentUsed: result.agentUsed,
      tokensUsed: result.tokensUsed,
      shouldHandoff: result.shouldHandoff,
      handoffReason: result.handoffReason ?? "",
      toolsCalled: result.toolsCalled,
      ragChunksUsed: result.ragChunksUsed,
      confidence: result.confidence,
    };
  }

  /** Grava a telemetria de uma interação. Best-effort: engole qualquer erro. */
  async recordFromResult(agent: AgentConfig, result: ProcessResult): Promise<void> {
    try {
      await this.repo.insert(agent.tenantId, agent.id, AnalyticsService.toInput(result));
    } catch (e) {
      log.warn(`Falha ao gravar telemetria (agent=${agent.id}): ${String(e)}`);
    }
  }

  /** Monta o dashboard do tenant (opcionalmente filtrado por um agente). */
  async dashboard(tenantId: string, opts: { days: number; agentSlug?: string | null }): Promise<Dashboard> {
    const days = Math.max(1, Math.min(365, Math.trunc(opts.days) || 30));
    const since = new Date(Date.now() - days * DAY_MS);
    const agentSlug = opts.agentSlug || null;
    const agentId = agentSlug ? `${tenantId}__${agentSlug}` : undefined;
    const scope = { tenantId, agentId, since };

    const [summary, byDay, byIntent, bySource, byAgent, topTools, recent] = await Promise.all([
      this.repo.summary(scope),
      this.repo.byDay(scope),
      this.repo.byIntent(scope),
      this.repo.bySource(scope),
      this.repo.byAgent(scope),
      this.repo.topTools(scope),
      this.repo.recent(scope),
    ]);

    return {
      range: { days, since: since.toISOString(), agentSlug },
      summary,
      byDay,
      byIntent,
      bySource,
      byAgent: byAgent.map((a) => ({ ...a, slug: slugOf(a.agentId, tenantId) })),
      topTools,
      recent: recent.map((r) => ({ ...r, slug: slugOf(r.agentId, tenantId) })),
    };
  }
}
