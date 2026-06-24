/**
 * BaseAgent: contrato + fluxo padrão de execução com LLM (porta `app/agents/base.py`).
 */

import { agentResult, type AgentConfig, type AgentResult, type ChatMessage } from "../domain";
import type { ChatMessageParam, LLMClient } from "../llm";
import { HANDOFF_TOKEN } from "../prompts";

export interface HandoffParse {
  shouldHandoff: boolean;
  clean: string;
  reason: string | null;
}

export function buildMessages(
  systemPrompt: string,
  userMessage: string,
  history: ChatMessage[],
): ChatMessageParam[] {
  const messages: ChatMessageParam[] = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  messages.push({ role: "user", content: userMessage });
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

  async execute(userMessage: string, history: ChatMessage[]): Promise<AgentResult> {
    const messages = buildMessages(this.systemPrompt(userMessage), userMessage, history);
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
