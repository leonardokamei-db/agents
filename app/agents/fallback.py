"""FallbackAgent: erros, timeouts e limite de turnos. Sempre faz handoff.

Estático de propósito (nenhuma chamada de LLM) — precisa funcionar justamente
quando o LLM é o que está falhando.
"""

import logging
from typing import List

from app.agents.base import BaseAgent

log = logging.getLogger("blip-agent.fallback")


class FallbackAgent(BaseAgent):
    source = "fallback"

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        log.info("FallbackAgent (history=%d) — handoff.", len(history))
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
