"""FAQAgent: responde perguntas via RAG sobre os documentos ingeridos.

Fonte única de verdade: o vector store do agente (app.rag). Para cada pergunta:

  1. Atalho RAG — se o chunk mais próximo é um match MUITO forte (distância L2
     abaixo de SHORTCUT_MAX_DISTANCE), retorna o chunk literal, sem LLM
     (source="faq_shortcut", 0 tokens).
  2. RAG + LLM — injeta os top-K chunks como contexto e o LLM compõe a
     resposta (source="llm_rag"). Se nada for recuperado, o modelo é instruído
     a fazer handoff.
"""

import asyncio
import logging
from typing import List

from app.agents.base import BaseAgent, build_messages, parse_handoff
from app.domain import AgentResult, ChatMessage
from app.prompts import faq_prompt
from app.rag import search_chunks

log = logging.getLogger("blip-agent.faq")

# Distância L2 máxima para o atalho determinístico (menor == mais similar).
# Conservador de propósito: só matches muito claros respondem sem LLM; o resto
# cai para o LLM, que extrai o trecho certo mesmo com ranking ruidoso.
SHORTCUT_MAX_DISTANCE = 0.90


class FAQAgent(BaseAgent):
    source = "llm_rag"

    def system_prompt(self, user_message: str) -> str:  # não usado (execute customizado)
        return faq_prompt(self.agent, [])

    async def execute(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        # Recuperação RAG (bloqueante -> worker thread).
        chunks = await asyncio.to_thread(search_chunks, self.agent.id, user_message)

        # 1. Atalho: match fortíssimo responde literal, sem LLM.
        if chunks and chunks[0]["score"] <= SHORTCUT_MAX_DISTANCE:
            top = chunks[0]
            log.info("RAG shortcut: source=%s dist=%.3f", top["source_name"], top["score"])
            return AgentResult(
                response=top["content"],
                source="faq_shortcut",
                rag_chunks_used=1,
                rag_sources=[top["source_name"]],
            )

        # 2. RAG + LLM.
        log.info("RAG: %d chunks (best=%.3f)", len(chunks),
                 chunks[0]["score"] if chunks else -1)
        messages = build_messages(faq_prompt(self.agent, chunks), user_message, history)
        text, tokens = await self.llm.complete(messages)

        should_handoff, clean, reason = parse_handoff(text)
        return AgentResult(
            response=clean,
            should_handoff=should_handoff,
            handoff_reason=reason,
            source="llm_rag",
            tokens_used=tokens,
            rag_chunks_used=len(chunks),
            rag_sources=sorted({c["source_name"] for c in chunks}),
        )
