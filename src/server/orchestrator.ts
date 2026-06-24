/**
 * Orchestrator (porta `app/orchestrator.py`): prepara o contexto e delega ao
 * agente flexível. Fino — só o transversal:
 *   1. Trunca o histórico (HISTORY_LIMIT).
 *   2. Conversa longa demais (> maxTurns) -> FallbackAgent (handoff estático).
 *   3. Senão, executa o SkilledAgent.
 *   4. Anexa metadados (intent derivado das skills usadas, tokens...).
 *   5. Qualquer exceção vira handoff gracioso (o detalhe fica só no log).
 *
 * Sem `lru_cache`: o Orchestrator é instanciado por request (barato); o LLMClient
 * é o singleton de getLlm().
 */

import { FallbackAgent, SkilledAgent } from "./agents";
import { HISTORY_LIMIT } from "./config";
import type { AgentConfig, AgentResult, ChatMessage } from "./domain";
import type { LLMClient } from "./llm";
import { getLogger } from "./logging";
import { ERROR_INTERNAL } from "./messages";

const log = getLogger("blip-agent.orchestrator");

// Skills de catálogo — só para derivar um "intent" legível dos metadados.
const CATALOG_SKILLS = new Set(["check_stock", "search_products", "list_products", "reserve_stock", "check_catalog"]);

export interface ProcessResult {
  response: string;
  shouldHandoff: boolean;
  handoffReason: string | null;
  source: string;
  tokensUsed: number;
  toolsCalled: string[];
  ragChunksUsed: number;
  ragSources: string[];
  intent: string;
  agentUsed: string;
  confidence: number;
}

function intentFromResult(result: AgentResult): string {
  const tools = new Set(result.toolsCalled);
  const source = result.source;
  if (source === "faq_shortcut" || source === "llm_rag" || tools.has("knowledge_search")) return "faq";
  if (source === "support_escalation" || tools.has("escalate_to_human")) return "support";
  for (const s of CATALOG_SKILLS) {
    if (tools.has(s)) return "order";
  }
  return "chat";
}

export class Orchestrator {
  private readonly config: AgentConfig;
  private readonly agent: SkilledAgent;
  private readonly fallback: FallbackAgent;

  constructor(agentConfig: AgentConfig, llm: LLMClient) {
    this.config = agentConfig;
    this.agent = new SkilledAgent(agentConfig, llm);
    this.fallback = new FallbackAgent(agentConfig, llm);
  }

  async process(message: string, history: ChatMessage[]): Promise<ProcessResult> {
    try {
      const recentHistory = history.slice(-HISTORY_LIMIT);

      // O comprimento TOTAL da conversa decide o limite de turnos.
      let result: AgentResult;
      let agentUsed: string;
      if (history.length > this.config.maxTurns) {
        result = await this.fallback.execute(message, recentHistory);
        agentUsed = "fallback";
      } else {
        result = await this.agent.execute(message, recentHistory);
        agentUsed = "skilled";
      }

      const intent = intentFromResult(result);
      log.info(
        `agent=${agentUsed} intent=${intent} handoff=${result.shouldHandoff} ` +
          `tokens=${result.tokensUsed} tools=${JSON.stringify(result.toolsCalled)}`,
      );
      return { ...result, intent, confidence: 1.0, agentUsed };
    } catch (e) {
      // O detalhe técnico fica só no log; a resposta usa a mensagem genérica.
      log.exception("Erro no orchestrator:", e);
      return {
        response: ERROR_INTERNAL,
        shouldHandoff: true,
        handoffReason: "Erro interno no processamento.",
        source: "error",
        tokensUsed: 0,
        toolsCalled: [],
        ragChunksUsed: 0,
        ragSources: [],
        intent: "error",
        agentUsed: "fallback",
        confidence: 0.0,
      };
    }
  }
}
