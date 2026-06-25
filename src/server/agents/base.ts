/**
 * BaseAgent: contrato + fluxo padrão de execução com LLM (porta `app/agents/base.py`).
 */

import { agentResult, type AgentConfig, type AgentResult, type ChatMessage } from "../domain";
import type { ChatMessageParam, LLMClient } from "../llm";
import { HANDOFF_TOKEN } from "../prompts";
import { makeSentinel, wrapUserData } from "../security/spotlight";

export interface HandoffParse {
  shouldHandoff: boolean;
  clean: string;
  reason: string | null;
}

/** Opções transversais decididas pelo Orchestrator (ex.: entrada suspeita). */
export interface ExecuteOptions {
  /** Entrada do turno levantou suspeita forte de injeção -> reforça o prompt. */
  hardened?: boolean;
}

/**
 * Monta as mensagens para o LLM. O conteúdo do CLIENTE (mensagem atual e turnos
 * `user` do histórico) é envolvido como DADO não confiável com o `sentinel` —
 * o system prompt instrui o modelo a nunca tratá-lo como instrução. Turnos
 * `assistant` (respostas anteriores do bot) não são reembrulhados.
 */
export function buildMessages(
  systemPrompt: string,
  userMessage: string,
  history: ChatMessage[],
  sentinel: string,
): ChatMessageParam[] {
  const messages: ChatMessageParam[] = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.content });
    } else {
      messages.push({ role: "user", content: wrapUserData(sentinel, m.content) });
    }
  }
  messages.push({ role: "user", content: wrapUserData(sentinel, userMessage) });
  return messages;
}

/** Detecta o token [HANDOFF] e retorna { shouldHandoff, clean, reason }. */
export function parseHandoff(text: string): HandoffParse {
  const t = text.trim();
  const shouldHandoff = t.includes(HANDOFF_TOKEN);
  let clean = t.split(HANDOFF_TOKEN).join("").trim();
  let reason: string | null = null;
  if (shouldHandoff) {
    reason = "O assistente encaminhou para um atendente humano.";
    if (!clean) clean = "Vou transferir você para um atendente humano para ajudar com isso.";
  }
  return { shouldHandoff, clean, reason };
}

export abstract class BaseAgent {
  source = "llm";

  constructor(
    protected readonly agent: AgentConfig,
    protected readonly llm: LLMClient,
  ) {}

  abstract systemPrompt(userMessage: string): string;

  async execute(userMessage: string, history: ChatMessage[], _opts?: ExecuteOptions): Promise<AgentResult> {
    const messages = buildMessages(this.systemPrompt(userMessage), userMessage, history, makeSentinel());
    const [text, tokens] = await this.llm.complete(messages);
    const { shouldHandoff, clean, reason } = parseHandoff(text);
    return agentResult({
      response: clean,
      shouldHandoff,
      handoffReason: reason,
      source: this.source,
      tokensUsed: tokens,
    });
  }
}
