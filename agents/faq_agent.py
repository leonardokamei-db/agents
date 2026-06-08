"""FAQAgent: answers questions using a RAG pipeline over ingested documents.

Single source of truth — the tenant's managed RAG store (see rag_store). Every
question embeds and retrieves the top-K most similar chunks, then:

  1. RAG shortcut — if the closest chunk is a *very* strong match (L2 distance
     below SHORTCUT_MAX_DISTANCE), return it verbatim with NO LLM call
     (source="faq_shortcut"). The threshold is deliberately conservative: the
     embedding model (all-MiniLM-L6-v2) is weak on Portuguese, so only the
     clearest matches are trusted to answer without the LLM. Most questions fall
     through to step 2 on purpose — including ones whose top chunk the ranker gets
     wrong (e.g. "horários de atendimento"), which is exactly why the threshold is
     low.
  2. RAG + LLM — inject the retrieved chunks as grounding context and let the LLM
     compose the answer (source="llm_rag"). Robust to a noisy ranking: as long as
     the right chunk is anywhere in the top-K, the LLM extracts it and ignores the
     rest, and says it doesn't know (handing off) when nothing fits.

Both paths read from the same managed store, so re-ingesting or deleting a
knowledge base changes the answers immediately — no hardcoded FAQ can shadow it.

`rag_store.search_chunks` is synchronous (model inference + SQLite), so it runs in
a worker thread via `asyncio.to_thread` to keep the FastAPI event loop responsive —
the same pattern used by the OrderAgent and the LLM client.
"""

import asyncio
import logging
from typing import List

from agents.base import BaseAgent
from rag_store import TOP_K, search_chunks

log = logging.getLogger("blip-agent.faq")

# Maximum L2 distance for the deterministic shortcut (lower == more similar).
# Calibrated against focused, section-level chunks: below 0.90 every top-1 match
# was correct, with a comfortable margin to the first wrong/off-topic match
# (~0.98+). Intentionally conservative — all-MiniLM-L6-v2 is weak on Portuguese,
# so for many questions the closest chunk is the *wrong* one; those score above
# the threshold and correctly fall through to the LLM. Re-tune if you change the
# embedding model or the corpus.
SHORTCUT_MAX_DISTANCE = 0.90


class FAQAgent(BaseAgent):
    source = "llm_rag"

    def _build_rag_prompt(self, chunks: List[dict]) -> str:
        """Inject the retrieved chunks (or a 'no info' notice) into the system prompt."""
        if chunks:
            rag_context = "\n\n".join(
                f"[Trecho {i + 1} — {c['source_name']}]\n{c['content']}"
                for i, c in enumerate(chunks)
            )
        else:
            rag_context = "Não há informações específicas disponíveis sobre esse assunto."

        return (
            f"{self.tenant['system_prompt']}\n\n"
            "## Base de conhecimento disponível:\n"
            f"{rag_context}\n\n"
            "Os trechos acima podem conter vários assuntos misturados — use apenas a "
            "parte que responde à pergunta do cliente e ignore o resto. Responda de "
            "forma objetiva e APENAS com base nas informações acima. Se a resposta não "
            "estiver nos trechos, diga que não sabe e escreva [HANDOFF]."
        )

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        # RAG retrieval over the tenant's ingested documents (blocking -> thread).
        chunks = await asyncio.to_thread(
            search_chunks, self.tenant["id"], user_message, TOP_K
        )

        # 1. Deterministic shortcut: only a very strong top match answers verbatim,
        #    no LLM. Source of truth is the managed store, so a re-ingested base is
        #    reflected immediately. Weak/ambiguous matches fall through to the LLM.
        if chunks and chunks[0]["score"] <= SHORTCUT_MAX_DISTANCE:
            top = chunks[0]
            log.info("RAG shortcut: source=%s dist=%.3f", top["source_name"], top["score"])
            return {
                "response": top["content"],
                "should_handoff": False,
                "handoff_reason": None,
                "source": "faq_shortcut",
                "tokens_used": 0,
                "tools_called": [],
                "rag_chunks_used": 1,
                "rag_sources": [top["source_name"]],
            }

        # 2. RAG + LLM fallback: inject the retrieved chunks and let the LLM answer
        #    (last 3 turns of history). Empty retrieval -> the model is told to hand off.
        if chunks:
            log.info("RAG retrieval: %d chunks, best dist=%.3f", len(chunks), chunks[0]["score"])
        else:
            log.info("RAG retrieval: 0 chunks for tenant=%s", self.tenant["id"])

        system_prompt = self._build_rag_prompt(chunks)
        text, tokens = await self.llm.call(
            system_prompt=system_prompt,
            user_message=user_message,
            history=history[-6:],
        )

        should_handoff, clean, reason = self.parse_handoff(text)
        return {
            "response": clean,
            "should_handoff": should_handoff,
            "handoff_reason": reason,
            "source": "llm_rag",
            "tokens_used": tokens,
            "tools_called": [],
            "rag_chunks_used": len(chunks),
            "rag_sources": sorted({c["source_name"] for c in chunks}),
        }