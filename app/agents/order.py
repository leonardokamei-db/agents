"""OrderAgent: consultas de catálogo e pedidos via tool use (function calling).

Nunca inventa preço/estoque: todo dado vem de uma tool que consulta o catálogo
(interno ou API externa, via app.catalog). Fluxo:

  1. Envia a mensagem + PRODUCT_TOOLS ao LLM.
  2. Enquanto o modelo retornar tool_calls, executa cada tool, devolve o JSON
     e chama o modelo de novo (com teto de iterações).
  3. O modelo formula a resposta final em texto.
  4. Se reserve_stock teve sucesso, should_handoff=True para um humano
     confirmar o pagamento.

O SDK do Groq é síncrono, então o loop inteiro roda em `asyncio.to_thread`.
"""

import asyncio
import json
import logging
from typing import List

from app.agents.base import BaseAgent, build_messages
from app.domain import AgentResult, ChatMessage
from app.llm import ToolUseFailedError, _tokens
from app.messages import DEGRADED_CATALOG, ORDER_CONFIRMED
from app.prompts import order_prompt
from app.tools import PRODUCT_TOOLS, execute_tool

log = logging.getLogger("blip-agent.order")

MAX_TOOL_ITERATIONS = 5  # teto de rodadas de tools por mensagem
TOOL_CALL_RETRIES = 2    # retries de uma chamada após tool call malformada


class OrderAgent(BaseAgent):
    source = "llm"

    def system_prompt(self, user_message: str) -> str:
        return order_prompt(self.agent)

    async def execute(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        return await asyncio.to_thread(self._run_tool_loop, user_message, history)

    def _run_tool_loop(self, user_message: str, history: List[ChatMessage]) -> AgentResult:
        """Loop de tool use bloqueante (roda em worker thread)."""
        messages = build_messages(self.system_prompt(user_message), user_message, history)
        tools_called: list[str] = []
        self._tokens_used = 0

        try:
            response = self._call(messages)
        except ToolUseFailedError:
            log.warning("Tool call malformada já na 1ª rodada; degradando.")
            return self._result(DEGRADED_CATALOG, tools_called)

        iterations = 0
        while (response.choices[0].finish_reason == "tool_calls"
               and iterations < MAX_TOOL_ITERATIONS):
            iterations += 1
            messages.append(response.choices[0].message)  # pedido de tools do modelo

            for tool_call in response.choices[0].message.tool_calls:
                tools_called.append(tool_call.function.name)
                try:
                    args = json.loads(tool_call.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": execute_tool(tool_call.function.name, args, self.agent),
                })

            try:
                response = self._call(messages)
            except ToolUseFailedError:
                # Já há resultados de tools no contexto: pede resposta em texto.
                log.warning("Tool call malformada no meio do loop; finalizando em texto.")
                return self._result(self._finalize_in_text(messages), tools_called)

        return self._result(response.choices[0].message.content or "", tools_called)

    def _call(self, messages: List[dict]):
        """complete_with_tools com retries para tool calls malformadas."""
        last_exc = None
        for attempt in range(TOOL_CALL_RETRIES + 1):
            try:
                response = self.llm.complete_with_tools(messages=messages, tools=PRODUCT_TOOLS)
                self._tokens_used += _tokens(response)
                return response
            except ToolUseFailedError as e:
                last_exc = e
                log.info("Retry %d/%d após tool_use_failed.", attempt + 1, TOOL_CALL_RETRIES)
        raise last_exc

    def _finalize_in_text(self, messages: List[ChatMessage]) -> str:
        """Pede uma resposta em texto puro com os dados de tools já coletados."""
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

    def _result(self, text: str, tools_called: List[str]) -> AgentResult:
        # reserve_stock == compra registrada -> humano confirma o pagamento.
        reserved = "reserve_stock" in tools_called
        text = (text or "").strip()
        if not text:
            text = ORDER_CONFIRMED if reserved else DEGRADED_CATALOG
        log.info("order ok: tools=%s tokens=%d reserved=%s",
                 tools_called, self._tokens_used, reserved)
        return AgentResult(
            response=text,
            should_handoff=reserved,
            handoff_reason=("Pedido confirmado — encaminhar para pagamento" if reserved else None),
            source=self.source,
            tokens_used=self._tokens_used,
            tools_called=tools_called,
        )
