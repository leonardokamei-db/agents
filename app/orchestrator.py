"""Orchestrator: decide QUAL agente atende cada mensagem.

Fluxo por requisição:
  1. Trunca o histórico para as últimas HISTORY_LIMIT mensagens (economia de
     tokens no Groq).
  2. Classifica a intenção (faq / support / order / unclear).
  3. Escolhe o agente: intenção com confiança alta, senão clarificação;
     conversa longa demais escala para o fallback.
  4. Executa e anexa metadados de roteamento.
Qualquer exceção vira um handoff gracioso.
"""

import logging
from typing import List

from app import classifier
from app.agents import (
    ClarificationAgent,
    FallbackAgent,
    FAQAgent,
    OrderAgent,
    SupportAgent,
)
from app.config import CONFIDENCE_THRESHOLD, HISTORY_LIMIT

log = logging.getLogger("blip-agent.orchestrator")


class Orchestrator:
    def __init__(self, agent_config: dict, llm):
        self.config = agent_config
        self.agents = {
            "faq": FAQAgent(agent_config, llm),
            "support": SupportAgent(agent_config, llm),
            "order": OrderAgent(agent_config, llm),
            "clarification": ClarificationAgent(agent_config, llm),
            "fallback": FallbackAgent(agent_config, llm),
        }

    async def process(self, message: str, history: List[dict]) -> dict:
        try:
            recent_history = history[-HISTORY_LIMIT:]
            intent, confidence = classifier.classify(message, recent_history)

            agent_key = "clarification"
            if confidence > CONFIDENCE_THRESHOLD and intent in ("faq", "support", "order"):
                agent_key = intent
            # O comprimento TOTAL da conversa decide o limite de turnos,
            # mesmo que só as últimas mensagens vão ao LLM.
            if len(history) > self.config["max_turns"]:
                agent_key = "fallback"

            agent = self.agents[agent_key]
            result = await agent.execute(message, recent_history)
            result.update(
                intent=intent,
                confidence=confidence,
                agent_used=agent_key,
            )

            log.info("intent=%s conf=%.2f agent=%s handoff=%s tokens=%d",
                     intent, confidence, agent_key,
                     result.get("should_handoff"), result.get("tokens_used", 0))
            return result

        except Exception as e:  # noqa: BLE001 — qualquer falha degrada em handoff.
            log.exception("Erro no orchestrator: %s", e)
            return {
                "response": "Desculpe, ocorreu um erro. Vou transferir você para um atendente.",
                "should_handoff": True,
                "handoff_reason": "Erro interno no processamento.",
                "source": "error",
                "intent": "error",
                "agent_used": "fallback",
                "confidence": 0.0,
                "tokens_used": 0,
                "error": str(e),
            }
