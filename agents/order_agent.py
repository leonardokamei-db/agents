"""OrderAgent — handles product queries and order intents using Groq tool use
(function calling).

The agent NEVER invents stock or prices: every fact comes from a tool call that
queries the SQLite product database. Flow:

  1. Send the user message + PRODUCT_TOOLS to the LLM.
  2. While the model returns tool_calls, execute each tool and feed the JSON
     results back, then call the model again.
  3. The model formulates a final natural-language response.
  4. If `reserve_stock` was called, flag should_handoff=True so a human can
     confirm payment.

The Groq SDK is synchronous, so the whole loop runs inside `asyncio.to_thread`.
"""

import asyncio
import json
import logging
from typing import List

from agents.base import BaseAgent
from llm_client import ToolUseFailedError
from tools import PRODUCT_TOOLS, execute_tool

log = logging.getLogger("blip-agent.order")

# Safety cap so a misbehaving model can't spin the tool loop forever.
MAX_TOOL_ITERATIONS = 5
# How many times to retry a single Groq call after a malformed tool call.
TOOL_CALL_RETRIES = 2
# Shown when the model keeps emitting malformed tool calls and we give up.
DEGRADED_MESSAGE = (
    "Desculpe, tive um problema ao consultar o catálogo. Você pode reformular "
    "informando o nome do produto e a quantidade? Se preferir, posso transferir "
    "você para um atendente."
)


class OrderAgent(BaseAgent):
    source = "llm"

    def _system_prompt(self) -> str:
        return (
            self.tenant["system_prompt"]
            + "\n\nMODO PEDIDOS: você ajuda o cliente a consultar o catálogo, "
            "verificar estoque e preços, e registrar pedidos. NUNCA invente "
            "preços, estoque ou produtos — use SEMPRE as ferramentas disponíveis "
            "para obter dados reais.\n"
            "Regras das ferramentas:\n"
            "- Chame UMA ferramenta por vez e aguarde o resultado.\n"
            "- Se não souber o nome exato do produto, use search_products ou "
            "list_products antes de check_stock.\n"
            "- Assim que tiver os dados necessários, RESPONDA em texto natural — "
            "não chame mais ferramentas.\n"
            "- Se um produto estiver sem estoque, informe e ofereça alternativas.\n"
            "- Só use reserve_stock quando o cliente confirmar explicitamente que "
            "deseja comprar.\n"
            "Responda sempre em português."
        )

    def _build_messages(self, user_message: str, history: List[dict]) -> List[dict]:
        messages = [{"role": "system", "content": self._system_prompt()}]
        messages.extend({"role": m["role"], "content": m["content"]} for m in history)
        messages.append({"role": "user", "content": user_message})
        return messages

    def _run_tool_loop(self, user_message: str, history: List[dict]) -> dict:
        """Blocking tool-use loop. Returns the final response dict.

        Runs entirely in a worker thread (see execute) so it never blocks the
        FastAPI event loop, even across multiple sequential Groq calls.
        """
        tenant_id = self.tenant["id"]
        messages = self._build_messages(user_message, history)
        all_tool_calls = []
        self._tokens = 0  # accumulated across every Groq call (incl. retries)

        try:
            response = self._call(messages)
        except ToolUseFailedError:
            # First call already failed to form a tool call — degrade gracefully.
            log.warning("OrderAgent: malformed tool call on first turn; degrading.")
            return self._degraded(all_tool_calls)

        iterations = 0
        while (response.choices[0].finish_reason == "tool_calls"
               and iterations < MAX_TOOL_ITERATIONS):
            iterations += 1
            tool_calls = response.choices[0].message.tool_calls

            # Append the assistant message that requested the tools.
            messages.append(response.choices[0].message)

            # Execute each requested tool and feed the result back.
            for tool_call in tool_calls:
                all_tool_calls.append(tool_call.function.name)
                try:
                    args = json.loads(tool_call.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = execute_tool(tool_call.function.name, args, tenant_id)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                })

            try:
                response = self._call(messages)
            except ToolUseFailedError:
                # The model already received tool results this round; ask it to
                # answer in plain text instead of attempting another tool call.
                log.warning("OrderAgent: malformed tool call mid-loop; "
                            "asking for a text answer with data gathered so far.")
                text = self._finalize_in_text(messages)
                return self._build_result(text, all_tool_calls)

        final_text = response.choices[0].message.content or ""
        return self._build_result(final_text, all_tool_calls)

    def _call(self, messages: List[dict]):
        """call_with_tools with a small retry budget for malformed tool calls.

        A `tool_use_failed` is a transient generation glitch; re-issuing the same
        request often succeeds. We retry up to TOOL_CALL_RETRIES times before
        re-raising so the caller can degrade gracefully."""
        last_exc = None
        for attempt in range(TOOL_CALL_RETRIES + 1):
            try:
                response = self.llm.call_with_tools(messages=messages, tools=PRODUCT_TOOLS)
                self._tokens += self._usage(response)
                return response
            except ToolUseFailedError as e:
                last_exc = e
                log.info("OrderAgent: retry %d/%d after tool_use_failed.",
                         attempt + 1, TOOL_CALL_RETRIES)
        raise last_exc

    def _finalize_in_text(self, messages: List[dict]) -> str:
        """Ask the model for a plain-language answer (no tools) using the tool
        results already in `messages`. Falls back to a canned message on error."""
        messages = messages + [{
            "role": "system",
            "content": ("Responda agora em texto natural, em português, usando os "
                        "dados das ferramentas já consultados. NÃO chame mais ferramentas."),
        }]
        try:
            text, tokens = self.llm._complete_sync(messages)
            self._tokens += tokens
            return text or DEGRADED_MESSAGE
        except Exception as e:  # noqa: BLE001 — last-resort fallback.
            log.warning("OrderAgent: text finalize failed: %s", e)
            return DEGRADED_MESSAGE

    def _build_result(self, final_text: str, all_tool_calls: List[str]) -> dict:
        # reserve_stock means a purchase was committed → human confirms payment.
        reserved = "reserve_stock" in all_tool_calls
        final_text = (final_text or "").strip()
        if not final_text and reserved:
            final_text = "Seu pedido foi registrado. Vou transferir você para finalizar o pagamento."
        elif not final_text:
            final_text = DEGRADED_MESSAGE
        return {
            "response": final_text,
            "should_handoff": reserved,
            "handoff_reason": ("Pedido confirmado — encaminhar para pagamento"
                               if reserved else None),
            "source": self.source,
            "tokens_used": self._tokens,
            "tools_called": all_tool_calls,
        }

    def _degraded(self, all_tool_calls: List[str]) -> dict:
        """Graceful degradation when no useful tool data could be gathered."""
        return {
            "response": DEGRADED_MESSAGE,
            "should_handoff": False,
            "handoff_reason": None,
            "source": self.source,
            "tokens_used": self._tokens,
            "tools_called": all_tool_calls,
        }

    @staticmethod
    def _usage(response) -> int:
        usage = getattr(response, "usage", None)
        if not usage:
            return 0
        return (usage.prompt_tokens or 0) + (usage.completion_tokens or 0)

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        return await asyncio.to_thread(self._run_tool_loop, user_message, history)
