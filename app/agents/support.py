"""SupportAgent: trata problemas com empatia; escala para humano mais rápido."""

import logging
from typing import List

from app.agents.base import BaseAgent
from app.domain import AgentResult, ChatMessage
from app.messages import ESCALATION_SUPPORT
from app.prompts import support_prompt
from app.textutil import word_set

log = logging.getLogger("blip-agent.support")

# Sinais de escalonamento imediato — handoff SEM chamar o LLM (0 tokens).
ESCALATION_KEYWORDS = {
    "reembolso", "estornar", "estorno", "cancelar", "processar", "advogado",
    "procon", "absurdo", "inaceitavel", "processo",
}


class SupportAgent(BaseAgent):
    source = "llm"

    def system_prompt(self, user_message: str) -> str:
        return support_prompt(self.agent)

    async def execute(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        if word_set(user_message) & ESCALATION_KEYWORDS:
            log.info("Escalonamento determinístico de suporte (0 tokens).")
            return AgentResult(
                response=ESCALATION_SUPPORT,
                should_handoff=True,
                handoff_reason="Problema de suporte sinalizado para escalonamento.",
                source="support_escalation",
            )
        return await super().execute(user_message, history)
