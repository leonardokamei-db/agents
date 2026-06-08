"""SupportAgent: handles support / problem follow-ups with empathy and customer
context. Escalates to a human faster than the FAQ agent.
"""

import logging
from typing import List

from agents.base import BaseAgent
from text_utils import word_set

log = logging.getLogger("blip-agent.support")

# Hard-escalation signals — if present, hand off to a human WITHOUT calling the LLM.
ESCALATION_KEYWORDS = {
    "reembolso", "estornar", "estorno", "cancelar", "processar", "advogado",
    "procon", "absurdo", "inaceitavel", "processo",
}

# Pre-written handoff message used when a hard-escalation keyword is detected.
# Sending this deterministically saves an entire LLM round-trip (0 tokens).
ESCALATION_MESSAGE = (
    "Entendo que isso é importante e quero garantir que seja resolvido da melhor "
    "forma. Vou transferir você para um atendente humano que poderá cuidar disso "
    "agora mesmo."
)


class SupportAgent(BaseAgent):
    source = "llm"

    def fetch_context(self, user_message: str, history: List[dict]) -> dict:
        # Compact support prompt — keeps input tokens low while preserving tone.
        guidelines = self.tenant.get("support_guidelines", "")
        system_prompt = (
            self.tenant["system_prompt"]
            + "\n\nMODO SUPORTE: seja empático e objetivo — reconheça o problema, "
            "peça desculpas se cabível e resolva. Se exigir intervenção humana "
            "(reembolso, cancelamento, reclamação formal) ou você não puder "
            "resolver, escreva [HANDOFF] no início da resposta."
        )
        if guidelines:
            system_prompt += f"\nDiretrizes: {guidelines}"
        return {"system_prompt": system_prompt}

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        # Hard escalation: skip the LLM entirely and hand off deterministically.
        if word_set(user_message) & ESCALATION_KEYWORDS:
            log.info("Support escalation keyword detected — forcing handoff (0 tokens, no LLM).")
            return {
                "response": ESCALATION_MESSAGE,
                "should_handoff": True,
                "handoff_reason": "Problema de suporte sinalizado para escalonamento.",
                "source": "support_escalation",
                "tokens_used": 0,
            }

        # Otherwise, normal empathetic LLM flow.
        return await super().execute(user_message, history)
