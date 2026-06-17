"""FallbackAgent: erros, timeouts e limite de turnos. Sempre faz handoff.

Estático de propósito (nenhuma chamada de LLM) — precisa funcionar justamente
quando o LLM é o que está falhando.
"""

import logging
from typing import List

from app.agents.base import BaseAgent
from app.domain import AgentResult, ChatMessage
from app.messages import FALLBACK_HANDOFF

log = logging.getLogger("blip-agent.fallback")


class FallbackAgent(BaseAgent):
    source = "fallback"

    def system_prompt(self, user_message: str) -> str:  # nunca usado (execute é estático)
        return ""

    async def execute(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        log.info("FallbackAgent (history=%d) — handoff.", len(history))
        return AgentResult(
            response=FALLBACK_HANDOFF,
            should_handoff=True,
            handoff_reason="Encaminhado ao atendimento humano (limite de interações ou erro).",
            source="fallback",
        )
