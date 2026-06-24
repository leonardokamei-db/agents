/**
 * FallbackAgent: erros, timeouts e limite de turnos. Sempre faz handoff.
 * Estático de propósito (sem LLM) — precisa funcionar quando o LLM é o que falha.
 * Porta `app/agents/fallback.py`.
 */

import { agentResult, type AgentResult, type ChatMessage } from "../domain";
import { getLogger } from "../logging";
import { FALLBACK_HANDOFF } from "../messages";
import { BaseAgent } from "./base";

const log = getLogger("blip-agent.fallback");

export class FallbackAgent extends BaseAgent {
  source = "fallback";

  systemPrompt(): string {
    return ""; // nunca usado (execute é estático)
  }

  async execute(_userMessage: string, history: ChatMessage[]): Promise<AgentResult> {
    log.info(`FallbackAgent (history=${history.length}) — handoff.`);
    return agentResult({
      response: FALLBACK_HANDOFF,
      shouldHandoff: true,
      handoffReason: "Encaminhado ao atendimento humano (limite de interações ou erro).",
      source: "fallback",
    });
  }
}
