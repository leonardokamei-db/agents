"""SkilledAgent: o agente flexível, dirigido por skills.

Substitui os antigos agentes rígidos por intenção (FAQ/Order/Support/Clarification).
Em vez de um classificador escolher UMA classe, este único agente recebe o
CONJUNTO de skills do agente (app.skills.enabled_skills_for) e deixa o LLM decidir
qual chamar, via function calling. É a generalização do loop que vivia no OrderAgent.

Fluxo de `execute`:

  1. Fast-path determinístico (0 token de LLM — preserva a economia):
     a. palavra-chave forte de escalonamento -> escalate_to_human direto;
     b. match RAG fortíssimo -> responde o chunk literal (atalho do antigo FAQ).
  2. Caso geral: loop de function-calling sobre as skills habilitadas. O modelo
     chama skills, recebe os resultados (JSON) e compõe a resposta em texto.
     - skill terminal (com direct_response, ex.: escalate) encerra o turno;
     - skill que pede handoff sem texto (ex.: reserve_stock) marca handoff e
       deixa o modelo redigir a confirmação.

O SDK do Groq é síncrono, então o loop inteiro roda em `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import List, Optional

from app.agents.base import BaseAgent, build_messages, parse_handoff
from app.domain import AgentResult, ChatMessage
from app.llm import ToolUseFailedError, _tokens
from app.messages import DEGRADED_CATALOG, ORDER_CONFIRMED
from app.prompts import skilled_prompt
from app.skills import SkillContext, enabled_skills_for, invoke_skill, tool_schemas_for
from app.skills.knowledge import SHORTCUT_MAX_DISTANCE
from app.skills.support import ESCALATION_KEYWORDS
from app.textutil import word_set

log = logging.getLogger("blip-agent.skilled")

MAX_TOOL_ITERATIONS = 5  # teto de rodadas de tools por mensagem
TOOL_CALL_RETRIES = 2    # retries de uma chamada após tool call malformada


class SkilledAgent(BaseAgent):
    source = "llm"

    def __init__(self, agent_config, llm):
        super().__init__(agent_config, llm)
        self.skill_names = enabled_skills_for(agent_config)
        self.tools = tool_schemas_for(self.skill_names)
        self.ctx = SkillContext(agent=agent_config)

    def system_prompt(self, user_message: str) -> str:
        return skilled_prompt(self.agent, self.skill_names)

    async def execute(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        # Fast-path 1: escalonamento determinístico por palavra-chave (0 token).
        if "escalate_to_human" in self.skill_names and (word_set(user_message) & ESCALATION_KEYWORDS):
            log.info("Escalonamento determinístico (0 tokens).")
            res = invoke_skill("escalate_to_human",
                               {"reason": "Palavra-chave de escalonamento."}, self.ctx)
            return AgentResult(
                response=res.direct_response or "",
                should_handoff=True,
                handoff_reason=res.handoff_reason,
                source="support_escalation",
            )

        # Fast-path 2: atalho RAG fortíssimo (0 token de LLM; só um embedding).
        if "knowledge_search" in self.skill_names and self.agent.rag_enabled:
            shortcut = await asyncio.to_thread(self._rag_shortcut, user_message)
            if shortcut is not None:
                return shortcut

        # Caso geral: loop de function-calling sobre as skills habilitadas.
        return await asyncio.to_thread(self._run_loop, user_message, history)

    # --- fast-path RAG ----------------------------------------------------- #
    def _rag_shortcut(self, user_message: str) -> Optional[AgentResult]:
        """Reusa a skill knowledge_search; se o melhor match for fortíssimo,
        responde o chunk literal sem LLM (mesmo atalho do antigo FAQAgent)."""
        res = invoke_skill("knowledge_search", {"query": user_message}, self.ctx)
        results = (res.data or {}).get("results") or []
        if results and results[0]["score"] <= SHORTCUT_MAX_DISTANCE:
            top = results[0]
            log.info("RAG shortcut: source=%s dist=%.3f", top["source"], top["score"])
            return AgentResult(
                response=top["content"],
                source="faq_shortcut",
                rag_chunks_used=1,
                rag_sources=[top["source"]],
            )
        return None

    # --- loop de tools (bloqueante, roda em worker thread) ----------------- #
    def _run_loop(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        messages = build_messages(self.system_prompt(user_message), user_message, history)
        self._tokens_used = 0
        self._tools_called: list[str] = []
        self._sources: list[str] = []
        self._rag_chunks = 0
        self._pending_handoff = False
        self._handoff_reason: Optional[str] = None

        # Sem tools (caso raro): chat simples + parse de handoff pelo token.
        if not self.tools:
            text, tokens = self.llm.complete_sync(messages)
            self._tokens_used += tokens
            should, clean, reason = parse_handoff(text or "")
            return AgentResult(response=clean, should_handoff=should,
                               handoff_reason=reason, source="llm",
                               tokens_used=self._tokens_used)

        try:
            response = self._call(messages)
        except ToolUseFailedError:
            log.warning("Tool call malformada já na 1ª rodada; degradando.")
            return self._result(DEGRADED_CATALOG)

        iterations = 0
        while (response.choices[0].finish_reason == "tool_calls"
               and iterations < MAX_TOOL_ITERATIONS):
            iterations += 1
            messages.append(response.choices[0].message)  # pedido de tools do modelo

            terminal = self._handle_tool_calls(response.choices[0].message.tool_calls, messages)
            if terminal is not None:
                return terminal  # skill terminal (ex.: escalate) encerra o turno

            try:
                response = self._call(messages)
            except ToolUseFailedError:
                log.warning("Tool call malformada no meio do loop; finalizando em texto.")
                return self._result(self._finalize_in_text(messages))

        return self._result(response.choices[0].message.content or "")

    def _handle_tool_calls(self, tool_calls, messages: List[dict]) -> Optional[AgentResult]:
        """Executa cada skill pedida pelo modelo, devolve o resultado ao contexto
        e acumula metadados. Retorna um AgentResult se uma skill for TERMINAL
        (handoff com mensagem pronta), senão None (o loop continua)."""
        for tool_call in tool_calls:
            name = tool_call.function.name
            self._tools_called.append(name)
            try:
                args = json.loads(tool_call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            res = invoke_skill(name, args, self.ctx)
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": res.tool_payload(),
            })

            if name == "knowledge_search":
                self._rag_chunks += len((res.data or {}).get("results") or [])
            if res.sources:
                self._sources.extend(res.sources)

            if res.handoff:
                if res.direct_response:  # skill terminal -> encerra o turno já
                    return AgentResult(
                        response=res.direct_response,
                        should_handoff=True,
                        handoff_reason=res.handoff_reason,
                        source="support_escalation" if name == "escalate_to_human" else self.source,
                        tokens_used=self._tokens_used,
                        tools_called=self._tools_called,
                    )
                self._pending_handoff = True
                self._handoff_reason = res.handoff_reason
        return None

    def _call(self, messages: List[dict]):
        """complete_with_tools com retries para tool calls malformadas."""
        last_exc = None
        for attempt in range(TOOL_CALL_RETRIES + 1):
            try:
                response = self.llm.complete_with_tools(messages=messages, tools=self.tools)
                self._tokens_used += _tokens(response)
                return response
            except ToolUseFailedError as e:
                last_exc = e
                log.info("Retry %d/%d após tool_use_failed.", attempt + 1, TOOL_CALL_RETRIES)
        raise last_exc

    def _finalize_in_text(self, messages: List[ChatMessage]) -> str:
        """Pede uma resposta em texto puro com os dados de skills já coletados."""
        messages = messages + [{
            "role": "system",
            "content": ("Responda agora em texto natural, em português, usando os dados "
                        "das ferramentas já consultados. NÃO chame mais ferramentas."),
        }]
        try:
            text, tokens = self.llm.complete_sync(messages)
            self._tokens_used += tokens
            return text or DEGRADED_CATALOG
        except Exception as e:  # noqa: BLE001 — último recurso.
            log.warning("Finalização em texto falhou: %s", e)
            return DEGRADED_CATALOG

    def _result(self, text: str) -> AgentResult:
        text = (text or "").strip()
        should, clean, reason = parse_handoff(text)
        should = should or self._pending_handoff
        reason = reason or (self._handoff_reason if self._pending_handoff else None)
        if not clean:
            clean = ORDER_CONFIRMED if self._pending_handoff else DEGRADED_CATALOG
        # source informativo: RAG se a base foi consultada, senão llm.
        source = "llm_rag" if self._rag_chunks > 0 else "llm"
        log.info("skilled ok: tools=%s tokens=%d handoff=%s",
                 self._tools_called, self._tokens_used, should)
        return AgentResult(
            response=clean,
            should_handoff=should,
            handoff_reason=reason,
            source=source,
            tokens_used=self._tokens_used,
            tools_called=self._tools_called,
            rag_chunks_used=self._rag_chunks,
            rag_sources=sorted(set(self._sources)),
        )
