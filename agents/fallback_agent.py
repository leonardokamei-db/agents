"""FallbackAgent: handles errors, timeouts, and max-turn limits. Always hands off.

This agent is intentionally static (no LLM call) so it stays reliable even when the
LLM is the thing that's failing.
"""

import logging
from typing import List

from agents.base import BaseAgent

log = logging.getLogger("blip-agent.fallback")


class FallbackAgent(BaseAgent):
    source = "fallback"

    def fetch_context(self, user_message: str, history: List[dict]) -> dict:
        return {"turns": len(history)}

    def build_prompt(self, context, user_message, history):
        # Never calls the LLM.
        return []

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        log.info("FallbackAgent invoked (history_len=%d) — handing off.", len(history))
        return {
            "response": (
                "Para te atender melhor, vou transferir você para um de nossos "
                "atendentes humanos. Um momento, por favor."
            ),
            "should_handoff": True,
            "handoff_reason": "Encaminhado ao atendimento humano (limite de interações ou erro).",
            "source": "fallback",
            "tokens_used": 0,
        }
