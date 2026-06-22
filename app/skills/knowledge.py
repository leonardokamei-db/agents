"""Skill de conhecimento (a antiga FAQ, agora uma skill).

`knowledge_search` busca na base de conhecimento (RAG) do agente. O que antes era
o FAQAgent virou esta skill: o LLM a chama quando precisa de informação da base,
e o agente flexível também a usa no atalho determinístico de 0 token (match RAG
fortíssimo responde literal, sem LLM).

A recuperação vetorial vive em `app.rag` — aqui só a embrulhamos no contrato de
skill. Bloqueante (SQLite + embeddings): o agente chama dentro de `asyncio.to_thread`.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.rag import search_chunks
from app.skills.base import (
    CATEGORY_KNOWLEDGE,
    SkillContext,
    SkillResult,
    skill,
)

# Distância L2 máxima para o atalho determinístico (menor == mais similar).
# Conservador: só matches muito claros respondem sem LLM (preserva a economia de
# tokens que o FAQAgent tinha). O agente flexível importa esta constante.
SHORTCUT_MAX_DISTANCE = 0.90


class KnowledgeSearchArgs(BaseModel):
    query: str = Field(description="Pergunta ou termos a buscar na base de conhecimento.")


@skill(
    "knowledge_search",
    "Busca na base de conhecimento (FAQ, políticas, documentos) do negócio. "
    "Use para responder dúvidas sobre prazos, formas de pagamento, trocas, "
    "garantia, horários e qualquer informação institucional.",
    KnowledgeSearchArgs,
    category=CATEGORY_KNOWLEDGE,
)
def _knowledge_search(ctx: SkillContext, args: KnowledgeSearchArgs) -> SkillResult:
    if not ctx.agent.rag_enabled:
        return SkillResult(data={"knowledge_base": "desabilitada", "results": []})

    chunks = search_chunks(ctx.agent.id, args.query)
    results = [
        {"source": c["source_name"], "content": c["content"], "score": round(c["score"], 3)}
        for c in chunks
    ]
    return SkillResult(
        data={"count": len(results), "results": results},
        sources=sorted({c["source_name"] for c in chunks}),
    )
