"""Orchestrator — the brain that decides WHAT context to inject before the LLM.

Flow per request:
  1. Classify the user's intent (faq / support / unclear).
  2. Pick an agent stack based on intent + confidence.
  3. Escalate to the FallbackAgent if the conversation is too long.
  4. Execute the agent and enrich the result with routing metadata.
Any unhandled exception is caught and turned into a graceful error handoff.
"""

import logging
from typing import List

from agents.clarification_agent import ClarificationAgent
from agents.faq_agent import FAQAgent
from agents.fallback_agent import FallbackAgent
from agents.order_agent import OrderAgent
from agents.support_agent import SupportAgent
from classifier import IntentClassifier

log = logging.getLogger("blip-agent.orchestrator")

CONFIDENCE_THRESHOLD = 0.7


class Orchestrator:
    def __init__(self, tenant_config: dict, llm_client):
        self.tenant = tenant_config
        self.llm = llm_client
        self.classifier = IntentClassifier(tenant_config)
        self.agents = {
            "faq": FAQAgent(tenant_config, llm_client),
            "support": SupportAgent(tenant_config, llm_client),
            "order": OrderAgent(tenant_config, llm_client),
            "clarification": ClarificationAgent(tenant_config, llm_client),
            "fallback": FallbackAgent(tenant_config, llm_client),
        }

    async def process(self, message: str, history: List[dict]) -> dict:
        try:
            # 1. Classify intent.
            intent, confidence = self.classifier.classify(message, history)

            # 2. Select an agent. Default to clarification when unsure.
            agent_key = "clarification"
            if confidence > CONFIDENCE_THRESHOLD and intent in ("faq", "support", "order"):
                agent_key = intent

            # 3. Turn-limit safety mechanism → fallback handoff.
            if len(history) > self.tenant["max_turns"]:
                agent_key = "fallback"

            agent = self.agents[agent_key]

            # 4. Execute and enrich with routing metadata.
            result = await agent.execute(message, history)
            result["intent"] = intent
            result["confidence"] = confidence
            result["agent_used"] = agent.__class__.__name__.replace("Agent", "").lower()

            log.info("routed intent=%s confidence=%.2f -> agent=%s handoff=%s tokens=%d",
                     intent, confidence, result["agent_used"],
                     result.get("should_handoff"), result.get("tokens_used", 0))
            return result

        except Exception as e:  # noqa: BLE001 — any failure degrades to a handoff.
            log.exception("Orchestrator error: %s", e)
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
