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
import { HISTORY_LIMIT, PROMPT_GUARD_MODEL } from "./config";
import type { AgentConfig, AgentResult, ChatMessage } from "./domain";
import type { LLMClient } from "./llm";
import { getLogger } from "./logging";
import { ERROR_INTERNAL, injectionRefusal } from "./messages";
import { detectInjectionAcross } from "./security/injection";
import { sanitizeUntrusted } from "./security/sanitize";

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
  if (source === "support_escalation" || tools.has("escalate_to_human") || tools.has("create_ticket")) return "support";
  for (const s of CATALOG_SKILLS) {
    if (tools.has(s)) return "order";
  }
  return "chat";
}

export class Orchestrator {
  private readonly config: AgentConfig;
  private readonly llm: LLMClient;
  private readonly agent: SkilledAgent;
  private readonly fallback: FallbackAgent;

  constructor(agentConfig: AgentConfig, llm: LLMClient) {
    this.config = agentConfig;
    this.llm = llm;
    this.agent = new SkilledAgent(agentConfig, llm);
    this.fallback = new FallbackAgent(agentConfig, llm);
  }

  async process(message: string, history: ChatMessage[]): Promise<ProcessResult> {
    try {
      const recentHistory = history.slice(-HISTORY_LIMIT);

      // 1. Detecção de contaminação no texto BRUTO (antes de sanitizar — senão os
      //    sinais, como invisíveis e tokens de template, já teriam sumido).
      const verdict = detectInjectionAcross([message, ...recentHistory.map((m) => m.content)]);
      if (verdict.suspicious) {
        log.warn(`prompt suspeito: score=${verdict.score} reasons=${JSON.stringify(verdict.reasons)}`);
      }

      // 2. Classificador opcional em cascata: só quando o heurístico já suspeita
      //    E há modelo configurado. Fail-open (erro -> "unknown" -> sem efeito).
      let hardened = verdict.flagged;
      let refuse = verdict.refuse;
      if (!refuse && verdict.suspicious && PROMPT_GUARD_MODEL) {
        const guard = await this.llm.classifyInjection(message);
        if (guard === "injection") {
          hardened = true;
          refuse = true; // o modelo confirmou manipulação que a heurística não fechou
          log.warn("Guard de injeção classificou a entrada como maliciosa.");
        }
      }

      // 3. Manipulação de ALTA confiança: responde NO PAPEL, sem chamar o LLM
      //    (determinístico -> impossível de sofrer jailbreak). Não faz handoff:
      //    o bot permanece como o assistente configurado e convida a um pedido real.
      if (refuse) {
        log.warn(`prompt injection recusado (determinístico): reasons=${JSON.stringify(verdict.reasons)}`);
        return {
          response: injectionRefusal(this.config.name),
          shouldHandoff: false,
          handoffReason: null,
          source: "injection_refusal",
          tokensUsed: 0,
          toolsCalled: [],
          ragChunksUsed: 0,
          ragSources: [],
          intent: "chat",
          agentUsed: "guard",
          confidence: 1.0,
        };
      }

      // 4. Sanitiza tudo que efetivamente vai ao LLM (mensagem + histórico).
      const cleanMessage = sanitizeUntrusted(message);
      const cleanHistory = recentHistory.map((m) => ({ ...m, content: sanitizeUntrusted(m.content) }));

      // O comprimento TOTAL da conversa decide o limite de turnos.
      let result: AgentResult;
      let agentUsed: string;
      if (history.length > this.config.maxTurns) {
        result = await this.fallback.execute(cleanMessage, cleanHistory, { hardened });
        agentUsed = "fallback";
      } else {
        result = await this.agent.execute(cleanMessage, cleanHistory, { hardened });
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
