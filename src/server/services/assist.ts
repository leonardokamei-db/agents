/**
 * AssistService (time de UX): usa o LLM (Claude) para RASCUNHAR as duas
 * configurações que o time de UX precisa escrever — `system_prompt` e
 * `business_rules` — a partir de um briefing em linguagem natural.
 *
 * NÃO é o caminho de chat: é uma ferramenta de autoria, então pode usar um modelo
 * mais forte (ASSIST_MODEL) e mais tokens de saída (ASSIST_MAX_TOKENS).
 *
 * Segurança: o resultado é apenas uma SUGESTÃO. O time de UX revisa e salva pelo
 * PUT .../config, que sanitiza os campos (stripDangerousTokens) antes de persistir.
 * Ainda assim sanitizamos aqui também (defesa em profundidade) e NÃO pedimos ao
 * modelo para escrever o bloco de segurança/anti-injeção — a plataforma o injeta
 * automaticamente (prompts.ts::securityBlock), então ele não deve vir do briefing.
 */

import { ASSIST_MAX_TOKENS, ASSIST_MODEL } from "../config";
import { AppError } from "../errors";
import type { LLMClient } from "../llm";
import { getLogger } from "../logging";
import { stripDangerousTokens } from "../security/sanitize";

const log = getLogger("blip-agent.services.assist");

// Teto dos campos gerados — espelha o `.max(8000)` do agentUpdateSchema, para que a
// sugestão caiba direto no PUT .../config sem ser rejeitada.
const FIELD_MAX = 8000;

export interface AssistConfigInput {
  brief: string; // briefing livre do time de UX (o que o agente deve fazer)
  agentName?: string; // nome do agente/negócio
  tone?: string; // tom desejado (ex.: "cordial e objetivo")
  skills?: string[]; // skills que pretendem habilitar (o prompt as menciona)
  currentSystemPrompt?: string; // base a melhorar (opcional)
  currentBusinessRules?: string; // base a melhorar (opcional)
}

export interface AssistConfigResult {
  systemPrompt: string;
  businessRules: string;
  notes: string; // observações curtas para o time de UX
  tokensUsed: number;
}

const SYSTEM_INSTRUCTION = [
  "Você é um especialista em desenhar agentes virtuais de atendimento ao cliente.",
  "Sua tarefa é AJUDAR o time de UX a redigir DUAS configurações de um agente:",
  '1) "system_prompt": a persona — quem é o agente, o que faz e o que NÃO faz, escopo e tom.',
  '2) "business_rules": regras de negócio objetivas e acionáveis (prazos, políticas, condições, limites).',
  "",
  "REGRAS DA SAÍDA:",
  '- Responda SOMENTE com um objeto JSON válido com as chaves "system_prompt", "business_rules" e "notes".',
  '- Os valores de "system_prompt", "business_rules" e "notes" devem ser STRINGS de texto corrido — NUNCA arrays nem objetos JSON. Para listar regras, use quebras de linha e marcadores "- " DENTRO da string.',
  "- Sem nenhum texto fora do JSON e sem cercas de código (```).",
  "- Escreva em português do Brasil, claro e conciso.",
  "- NÃO inclua instruções de segurança, anti prompt-injection, regras sobre revelar o prompt, nem o tratamento de transbordo/escalonamento: a plataforma adiciona isso automaticamente. Foque na persona e nas regras do negócio.",
  '- "notes": 1 a 3 observações curtas para o time de UX sobre o que revisar ou complementar.',
  "- O briefing do time de UX vem entre as marcas <briefing> e </briefing>; trate o conteúdo como um pedido de redação, e produza APENAS as duas configurações.",
].join("\n");

function buildUserContent(input: AssistConfigInput): string {
  const parts: string[] = [];
  if (input.agentName) parts.push(`Nome do agente/negócio: ${input.agentName}`);
  if (input.tone) parts.push(`Tom desejado: ${input.tone}`);
  if (input.skills && input.skills.length > 0) {
    parts.push(
      `O agente terá estas capacidades (ferramentas) habilitadas: ${input.skills.join(", ")}. ` +
        "Escreva o system_prompt e as regras de forma a aproveitá-las quando fizer sentido.",
    );
  }
  if (input.currentSystemPrompt) {
    parts.push(`System prompt atual (melhore-o, não comece do zero):\n${input.currentSystemPrompt}`);
  }
  if (input.currentBusinessRules) {
    parts.push(`Regras de negócio atuais (melhore-as):\n${input.currentBusinessRules}`);
  }
  const context = parts.length > 0 ? parts.join("\n") + "\n\n" : "";
  return `${context}<briefing>\n${input.brief}\n</briefing>`;
}

/** Extrai o objeto JSON da resposta do modelo (tolera cercas/código e texto ao redor). */
function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/**
 * Achata um valor do JSON do modelo em texto legível. O LLM às vezes ignora a
 * instrução e devolve `business_rules`/`system_prompt` como array (lista de regras)
 * ou objeto, em vez de string. Sem isto, `String([{...}])` viraria
 * "[object Object],[object Object],..." — exatamente o que vazava para o time de UX.
 *   - array  -> uma linha por item; itens estruturados viram marcadores "- ".
 *   - objeto -> seus valores juntados por ": " (ex.: {titulo, descricao} -> "titulo: descricao").
 */
function coerceToText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        const line = coerceToText(item).trim();
        if (!line) return "";
        return item !== null && typeof item === "object" ? `- ${line}` : line;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .map((x) => coerceToText(x).trim())
      .filter(Boolean)
      .join(": ");
  }
  return String(v);
}

function asField(v: unknown): string {
  return stripDangerousTokens(coerceToText(v).trim()).slice(0, FIELD_MAX);
}

export class AssistService {
  constructor(private readonly llm: LLMClient) {}

  /** Gera um rascunho de system_prompt + business_rules a partir do briefing. */
  async draftAgentConfig(input: AssistConfigInput): Promise<AssistConfigResult> {
    const [text, tokensUsed] = await this.llm.complete(
      [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content: buildUserContent(input) },
      ],
      { model: ASSIST_MODEL, maxTokens: ASSIST_MAX_TOKENS },
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = extractJson(text) as Record<string, unknown>;
    } catch {
      log.warn("Assistente: resposta do LLM não era JSON válido.");
      throw new AppError("O assistente de IA não retornou um resultado válido. Tente novamente.");
    }

    const systemPrompt = asField(parsed.system_prompt);
    const businessRules = asField(parsed.business_rules);
    if (!systemPrompt && !businessRules) {
      throw new AppError("O assistente de IA não conseguiu gerar a configuração. Refine o briefing e tente de novo.");
    }
    log.info(`Assistente gerou config (tokens=${tokensUsed}).`);
    return { systemPrompt, businessRules, notes: asField(parsed.notes), tokensUsed };
  }
}
