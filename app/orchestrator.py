"""Orchestrator: prepara o contexto e delega ao agente flexível.

Com o modelo de skills, o roteamento por classificador de palavra-chave deixou de
existir — quem decide QUAL capacidade usar é o LLM, chamando as skills do agente
(ver app.agents.skilled). O Orchestrator ficou fino e cuida só do transversal:

  1. Trunca o histórico para as últimas HISTORY_LIMIT mensagens (economia de tokens).
  2. Conversa longa demais (acima de max_turns) -> fallback estático (handoff).
  3. Senão, executa o SkilledAgent.
  4. Anexa metadados de roteamento (intent derivado das skills usadas, tokens...).
  5. Qualquer exceção vira um handoff gracioso (o str(e) fica só no log).
"""

import logging
from typing import TYPE_CHECKING, List

from app.agents import FallbackAgent, SkilledAgent
from app.config import HISTORY_LIMIT
from app.domain import AgentConfig, ChatMessage
from app.messages import ERROR_INTERNAL

if TYPE_CHECKING:
    from app.llm import LLMClient

log = logging.getLogger("blip-agent.orchestrator")

# Skills de catálogo — usado só para derivar um "intent" legível dos metadados.
_CATALOG_SKILLS = {"check_stock", "search_products", "list_products",
                   "reserve_stock", "check_catalog"}


def _intent_from_result(result: dict) -> str:
    """Rótulo legível da capacidade usada (para o painel/avaliação). Substitui o
    intent do antigo classificador — agora é derivado das skills efetivamente
    chamadas, não de um palpite por palavra-chave."""
    tools = set(result.get("tools_called") or [])
    source = result.get("source")
    if source in ("faq_shortcut", "llm_rag") or "knowledge_search" in tools:
        return "faq"
    if source == "support_escalation" or "escalate_to_human" in tools:
        return "support"
    if tools & _CATALOG_SKILLS:
        return "order"
    return "chat"


class Orchestrator:
    def __init__(self, agent_config: AgentConfig, llm: "LLMClient"):
        self.config = agent_config
        self.agent = SkilledAgent(agent_config, llm)
        self.fallback = FallbackAgent(agent_config, llm)

    async def process(self, message: str, history: List[ChatMessage]) -> dict:
        try:
            recent_history = history[-HISTORY_LIMIT:]

            # O comprimento TOTAL da conversa decide o limite de turnos, mesmo que
            # só as últimas mensagens vão ao LLM.
            if len(history) > self.config.max_turns:
                agent_result = await self.fallback.execute(message, recent_history)
                agent_used = "fallback"
            else:
                agent_result = await self.agent.execute(message, recent_history)
                agent_used = "skilled"

            result = agent_result.to_dict()
            # Sem classificador: o "intent" vem das skills usadas e a confiança é
            # 1.0 (a decisão é do LLM, não mais um score de palavra-chave).
            result.update(intent=_intent_from_result(result), confidence=1.0,
                          agent_used=agent_used)

            log.info("agent=%s intent=%s handoff=%s tokens=%d tools=%s",
                     agent_used, result["intent"], result["should_handoff"],
                     result["tokens_used"], result.get("tools_called"))
            return result

        except Exception as e:  # noqa: BLE001 — qualquer falha degrada em handoff.
            # O detalhe técnico fica só no log (correlacionado por request/tenant);
            # a resposta ao usuário usa a mensagem genérica e NÃO vaza str(e).
            log.exception("Erro no orchestrator: %s", e)
            return {
                "response": ERROR_INTERNAL,
                "should_handoff": True,
                "handoff_reason": "Erro interno no processamento.",
                "source": "error",
                "intent": "error",
                "agent_used": "fallback",
                "confidence": 0.0,
                "tokens_used": 0,
            }
