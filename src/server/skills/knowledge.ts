/**
 * Skill de conhecimento (a antiga FAQ). `knowledge_search` busca na base RAG do
 * agente. Porta `app/skills/knowledge.py`.
 */

import { z } from "zod";

import { searchChunks } from "../rag";
import { CATEGORY_KNOWLEDGE, registerLocal, SkillResult } from "./base";

// Distância L2 máxima para o atalho determinístico (menor == mais similar).
// Conservador: só matches muito claros respondem sem LLM (preserva a economia).
export const SHORTCUT_MAX_DISTANCE = 0.9;

const knowledgeSearchArgs = z.object({
  query: z.string().describe("Pergunta ou termos a buscar na base de conhecimento."),
});

registerLocal(
  "knowledge_search",
  "Busca na base de conhecimento (FAQ, políticas, documentos) do negócio. " +
    "Use para responder dúvidas sobre prazos, formas de pagamento, trocas, " +
    "garantia, horários e qualquer informação institucional.",
  knowledgeSearchArgs,
  async (ctx, args) => {
    if (!ctx.agent.ragEnabled) {
      return new SkillResult({ data: { knowledge_base: "desabilitada", results: [] } });
    }
    const found = await searchChunks(ctx.agent.id, args.query);
    const results = found.map((c) => ({
      source: c.source_name,
      content: c.content,
      score: Math.round(c.score * 1000) / 1000,
    }));
    return new SkillResult({
      data: { count: results.length, results },
      sources: [...new Set(found.map((c) => c.source_name))].sort(),
    });
  },
  CATEGORY_KNOWLEDGE,
);
