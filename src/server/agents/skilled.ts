/**
 * SkilledAgent: o agente flexível, dirigido por skills (porta `app/agents/skilled.py`).
 *
 * Recebe o CONJUNTO de skills do agente e deixa o LLM decidir qual chamar (function
 * calling). Um fast-path determinístico (0 token) preserva a economia:
 *   a. palavra-chave forte de escalonamento -> escalate_to_human direto.
 * Caso geral: loop de function-calling com teto e retries para tool_use_failed.
 */

import { agentResult, type AgentConfig, type AgentResult, type ChatMessage } from "../domain";
import { getLogger } from "../logging";
import { type ChatCompletion, type ChatMessageParam, type ChatTool, type LLMClient, type ToolCall, type ToolResult, ToolUseFailedError, tokensOf } from "../llm";
import { DEGRADED_CATALOG, ORDER_CONFIRMED } from "../messages";
import { skilledPrompt } from "../prompts";
import { sanitizeUntrusted } from "../security/sanitize";
import { makeSentinel, wrapToolData } from "../security/spotlight";
import { enabledSkillsFor, invokeSkill, type SkillContext, toolSchemasFor } from "../skills";
import { ESCALATION_KEYWORDS } from "../skills/support";
import { wordSet } from "../textutil";
import { BaseAgent, buildMessages, type ExecuteOptions, parseHandoff } from "./base";

const log = getLogger("blip-agent.skilled");

const MAX_TOOL_ITERATIONS = 5; // teto de rodadas de tools por mensagem
const TOOL_CALL_RETRIES = 2; // retries de uma chamada após tool call malformada

interface LoopState {
  tokensUsed: number;
  toolsCalled: string[];
  sources: string[];
  ragChunks: number;
  pendingHandoff: boolean;
  handoffReason: string | null;
}

interface KnowledgeData {
  results?: Array<{ source: string; content: string; score: number }>;
}

export class SkilledAgent extends BaseAgent {
  source = "llm";
  private readonly skillNames: string[];
  private readonly tools: ChatTool[];
  private readonly ctx: SkillContext;

  constructor(agentConfig: AgentConfig, llm: LLMClient) {
    super(agentConfig, llm);
    this.skillNames = enabledSkillsFor(agentConfig);
    this.tools = toolSchemasFor(this.skillNames);
    this.ctx = { agent: agentConfig };
  }

  systemPrompt(): string {
    // Contrato do BaseAgent. O fluxo real (runLoop) monta o prompt com o
    // sentinela do turno; este caminho não é usado em runtime pelo SkilledAgent.
    return skilledPrompt(this.agent, this.skillNames, makeSentinel());
  }

  async execute(userMessage: string, history: ChatMessage[], opts?: ExecuteOptions): Promise<AgentResult> {
    const hardened = opts?.hardened ?? false;

    // Fast-path 1: escalonamento determinístico por palavra-chave (0 token).
    if (this.skillNames.includes("escalate_to_human") && hasEscalationKeyword(userMessage)) {
      log.info("Escalonamento determinístico (0 tokens).");
      const res = await invokeSkill("escalate_to_human", { reason: "Palavra-chave de escalonamento." }, this.ctx);
      return agentResult({
        response: res.directResponse ?? "",
        shouldHandoff: true,
        handoffReason: res.handoffReason,
        source: "support_escalation",
      });
    }

    // Caso geral: loop de function-calling sobre as skills habilitadas.
    return this.runLoop(userMessage, history, hardened);
  }

  // --- loop de tools ------------------------------------------------------- //
  private async runLoop(userMessage: string, history: ChatMessage[], hardened: boolean): Promise<AgentResult> {
    const sentinel = makeSentinel();
    const systemPrompt = skilledPrompt(this.agent, this.skillNames, sentinel, hardened);
    const messages = buildMessages(systemPrompt, userMessage, history, sentinel);
    const state: LoopState = {
      tokensUsed: 0,
      toolsCalled: [],
      sources: [],
      ragChunks: 0,
      pendingHandoff: false,
      handoffReason: null,
    };

    // Sem tools (caso raro): chat simples + parse de handoff pelo token.
    if (this.tools.length === 0) {
      const [text, tokens] = await this.llm.complete(messages);
      state.tokensUsed += tokens;
      const { shouldHandoff, clean, reason } = parseHandoff(text || "");
      return agentResult({
        response: clean,
        shouldHandoff,
        handoffReason: reason,
        source: "llm",
        tokensUsed: state.tokensUsed,
      });
    }

    let response: ChatCompletion;
    try {
      response = await this.call(messages, state);
    } catch (e) {
      if (e instanceof ToolUseFailedError) {
        log.warn("Tool call malformada já na 1ª rodada; degradando.");
        return this.result(DEGRADED_CATALOG, state);
      }
      throw e;
    }

    let iterations = 0;
    while (response.stoppedForTools && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      // Reecoa o turno do assistente que pediu as ferramentas (texto + tool calls).
      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

      const terminal = await this.handleToolCalls(response.toolCalls, messages, state, sentinel);
      if (terminal !== null) return terminal; // skill terminal (ex.: escalate)

      try {
        response = await this.call(messages, state);
      } catch (e) {
        if (e instanceof ToolUseFailedError) {
          log.warn("Tool call malformada no meio do loop; finalizando em texto.");
          return this.result(await this.finalizeInText(messages, state), state);
        }
        throw e;
      }
    }

    return this.result(response.text, state);
  }

  private async handleToolCalls(
    toolCalls: ToolCall[],
    messages: ChatMessageParam[],
    state: LoopState,
    sentinel: string,
  ): Promise<AgentResult | null> {
    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      const name = tc.name;
      state.toolsCalled.push(name);
      const args = tc.args ?? {}; // a Anthropic já entrega o input desserializado

      const res = await invokeSkill(name, args, this.ctx);
      // Saída de skill = DADO não confiável (chunk de RAG, catálogo externo):
      // sanitiza e envolve no bloco delimitado antes de devolver ao LLM.
      const payload = wrapToolData(sentinel, name, sanitizeUntrusted(res.toolPayload()));
      results.push({ toolCallId: tc.id, content: payload });

      if (name === "knowledge_search") {
        state.ragChunks += ((res.data as KnowledgeData | null)?.results ?? []).length;
      }
      if (res.sources.length > 0) state.sources.push(...res.sources);

      if (res.handoff) {
        if (res.directResponse) {
          // skill terminal -> encerra o turno já (sem continuar a conversa)
          return agentResult({
            response: res.directResponse,
            shouldHandoff: true,
            handoffReason: res.handoffReason,
            source: name === "escalate_to_human" ? "support_escalation" : this.source,
            tokensUsed: state.tokensUsed,
            toolsCalled: state.toolsCalled,
          });
        }
        state.pendingHandoff = true;
        state.handoffReason = res.handoffReason;
      }
    }
    // Todos os resultados desta rodada vão num único turno user (Messages API).
    messages.push({ role: "tool", results });
    return null;
  }

  /** completeWithTools com retries para tool calls malformadas. */
  private async call(messages: ChatMessageParam[], state: LoopState): Promise<ChatCompletion> {
    let lastExc: unknown = null;
    for (let attempt = 0; attempt <= TOOL_CALL_RETRIES; attempt++) {
      try {
        const response = await this.llm.completeWithTools(messages, this.tools);
        state.tokensUsed += tokensOf(response);
        return response;
      } catch (e) {
        if (e instanceof ToolUseFailedError) {
          lastExc = e;
          log.info(`Retry ${attempt + 1}/${TOOL_CALL_RETRIES} após tool_use_failed.`);
          continue;
        }
        throw e;
      }
    }
    throw lastExc;
  }

  private async finalizeInText(messages: ChatMessageParam[], state: LoopState): Promise<string> {
    const extended: ChatMessageParam[] = [
      ...messages,
      {
        role: "system",
        content:
          "Responda agora em texto natural, em português, usando os dados das " +
          "ferramentas já consultados. NÃO chame mais ferramentas.",
      },
    ];
    try {
      const [text, tokens] = await this.llm.complete(extended);
      state.tokensUsed += tokens;
      return text || DEGRADED_CATALOG;
    } catch (e) {
      log.warn("Finalização em texto falhou:", String(e));
      return DEGRADED_CATALOG;
    }
  }

  private result(text: string, state: LoopState): AgentResult {
    const { shouldHandoff, clean, reason } = parseHandoff((text || "").trim());
    const finalHandoff = shouldHandoff || state.pendingHandoff;
    const finalReason = reason ?? (state.pendingHandoff ? state.handoffReason : null);
    let finalClean = clean;
    if (!finalClean) finalClean = state.pendingHandoff ? ORDER_CONFIRMED : DEGRADED_CATALOG;
    const source = state.ragChunks > 0 ? "llm_rag" : "llm";
    log.info(`skilled ok: tools=${JSON.stringify(state.toolsCalled)} tokens=${state.tokensUsed} handoff=${finalHandoff}`);
    return agentResult({
      response: finalClean,
      shouldHandoff: finalHandoff,
      handoffReason: finalReason,
      source,
      tokensUsed: state.tokensUsed,
      toolsCalled: state.toolsCalled,
      ragChunksUsed: state.ragChunks,
      ragSources: [...new Set(state.sources)].sort(),
    });
  }
}

function hasEscalationKeyword(userMessage: string): boolean {
  for (const w of wordSet(userMessage)) {
    if (ESCALATION_KEYWORDS.has(w)) return true;
  }
  return false;
}
