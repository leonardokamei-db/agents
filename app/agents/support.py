"""SupportAgent: trata problemas com empatia; escala para humano mais rápido."""

import logging
from typing import List

from app.agents.base import BaseAgent
from app.prompts import support_prompt
from app.textutil import word_set

log = logging.getLogger("blip-agent.support")

# Sinais de escalonamento imediato — handoff SEM chamar o LLM (0 tokens).
ESCALATION_KEYWORDS = {
    "reembolso", "estornar", "estorno", "cancelar", "processar", "advogado",
    "procon", "absurdo", "inaceitavel", "processo",
}

ESCALATION_MESSAGE = (
    "Entendo que isso é importante e quero garantir que seja resolvido da melhor "
    "forma. Vou transferir você para um atendente humano que poderá cuidar disso "
    "agora mesmo."
)


class SupportAgent(BaseAgent):
    source = "llm"

    def system_prompt(self, user_message: str) -> str:
        return support_prompt(self.agent)

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        if word_set(user_message) & ESCALATION_KEYWORDS:
            log.info("Escalonamento determinístico de suporte (0 tokens).")
            return {
                "response": ESCALATION_MESSAGE,
                "should_handoff": True,
                "handoff_reason": "Problema de suporte sinalizado para escalonamento.",
                "source": "support_escalation",
                "tokens_used": 0,
            }
        return await super().execute(user_message, history)
