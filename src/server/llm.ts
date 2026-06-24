/**
 * Cliente Groq (porta `app/llm.py`) usando o SDK Node `groq-sdk`.
 *
 * Diferente do Python, aqui não há `asyncio.to_thread`: o SDK é assíncrono e o
 * I/O não bloqueia o event loop. Cliente como singleton de módulo.
 */

import Groq from "groq-sdk";

import * as config from "./config";
import type { ChatMessage } from "./domain";
import { getLogger } from "./logging";

const log = getLogger("blip-agent.llm");

export type ChatCompletion = Groq.Chat.ChatCompletion;
export type ChatMessageParam = Groq.Chat.ChatCompletionMessageParam;
export type ChatTool = Groq.Chat.ChatCompletionTool;
export type ChatMessageToolCall = Groq.Chat.ChatCompletionMessageToolCall;

/**
 * O modelo emitiu uma tool call malformada e o Groq rejeitou (HTTP 400, code
 * "tool_use_failed"). Glitch transitório de geração — o chamador tenta de novo
 * ou degrada com elegância.
 */
export class ToolUseFailedError extends Error {}

function mapGroqError(e: unknown): Error {
  if (e instanceof Groq.APIConnectionError) return new Error("Falha de conexão com o Groq.");
  if (e instanceof Groq.RateLimitError) {
    return new Error("Limite de requisições do Groq atingido. Tente novamente em instantes.");
  }
  if (e instanceof Groq.APIError) return new Error(`Erro do Groq: ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

export class LLMClient {
  readonly model: string;
  private readonly client: Groq;

  constructor() {
    this.model = config.GROQ_MODEL;
    this.client = new Groq({ apiKey: config.GROQ_API_KEY });
  }

  /** Chat completion sem ferramentas. Retorna [texto, tokens]. */
  async complete(messages: ChatMessage[]): Promise<[string, number]> {
    let resp: ChatCompletion;
    try {
      resp = await this.client.chat.completions.create({
        model: this.model,
        messages: messages as ChatMessageParam[],
        max_tokens: config.LLM_MAX_TOKENS,
        temperature: config.LLM_TEMPERATURE,
      });
    } catch (e) {
      throw mapGroqError(e);
    }
    return [resp.choices[0]?.message?.content ?? "", tokensOf(resp)];
  }

  /**
   * Chamada com tool definitions. Retorna a completion crua para o chamador
   * inspecionar `tool_calls`. Mapeia `tool_use_failed` para ToolUseFailedError.
   */
  async completeWithTools(messages: ChatMessageParam[], tools: ChatTool[]): Promise<ChatCompletion> {
    try {
      return await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools,
        tool_choice: "auto",
        max_tokens: 1024,
        temperature: 0.3, // temperatura baixa para precisão em pedidos
      });
    } catch (e) {
      if (e instanceof Groq.BadRequestError) {
        const err = e as unknown as { code?: string; error?: { code?: string; failed_generation?: string } };
        const code = err.code ?? err.error?.code;
        if (code === "tool_use_failed") {
          log.warn("Groq tool_use_failed:", err.error?.failed_generation ?? "");
          throw new ToolUseFailedError("O modelo gerou uma chamada de ferramenta malformada.");
        }
      }
      throw mapGroqError(e);
    }
  }
}

let singleton: LLMClient | null = null;

/** Instância única do cliente, criada no primeiro uso. */
export function getLlm(): LLMClient {
  if (singleton === null) singleton = new LLMClient();
  return singleton;
}

export function tokensOf(resp: ChatCompletion): number {
  const usage = resp.usage;
  if (!usage) return 0;
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}
