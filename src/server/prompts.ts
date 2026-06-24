/**
 * Construção de system prompts compactos (porta `app/prompts.py`).
 * Base de ~2 frases + só as regras das famílias de skill habilitadas. Menos
 * texto fixo == menos tokens de entrada em TODA chamada ao Groq.
 */

import type { AgentConfig } from "./domain";

export const HANDOFF_TOKEN = "[HANDOFF]";

const CATALOG_SKILLS = new Set([
  "check_stock",
  "search_products",
  "list_products",
  "reserve_stock",
  "check_catalog",
]);

export function basePrompt(agent: AgentConfig): string {
  let prompt =
    (agent.systemPrompt || "").trim() ||
    `Você é o assistente virtual de ${agent.name}. Responda em português, ` +
      `de forma breve e cordial. Se não souber responder com as informações ` +
      `disponíveis, comece a resposta com ${HANDOFF_TOKEN}.`;
  const rules = (agent.businessRules || "").trim();
  if (rules) prompt += `\nRegras de negócio: ${rules}`;
  return prompt;
}

export function skilledPrompt(agent: AgentConfig, skillNames: string[]): string {
  const has = new Set(skillNames);
  const rules: string[] = [];
  if ([...CATALOG_SKILLS].some((s) => has.has(s))) {
    rules.push("para catálogo, estoque e preços consulte SEMPRE pelas ferramentas — nunca invente dados");
  }
  if (has.has("reserve_stock")) {
    rules.push("use reserve_stock só após confirmação explícita de compra");
  }
  if (has.has("knowledge_search")) {
    rules.push("para dúvidas sobre informações/políticas do negócio, use knowledge_search");
  }
  if (has.has("escalate_to_human")) {
    rules.push("se precisar de uma pessoa, use escalate_to_human");
  }

  const parts = [basePrompt(agent)];
  if (rules.length > 0) {
    parts.push(
      "Você tem ferramentas para obter dados reais: " +
        rules.join("; ") +
        ". Uma ferramenta por vez; com os dados em mãos, responda em texto.",
    );
  }
  return parts.join("\n");
}
