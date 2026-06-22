"""Cliente Groq.

O SDK do Groq é síncrono; chamadas bloqueantes rodam em worker thread via
`asyncio.to_thread` para não travar o event loop do FastAPI.
"""

import asyncio
import logging
from typing import List, Tuple

import groq
from groq import Groq
from groq.types.chat import ChatCompletion

from app import config
from app.domain import ChatMessage

log = logging.getLogger("blip-agent.llm")


class ToolUseFailedError(RuntimeError):
    """O modelo emitiu uma tool call malformada e o Groq rejeitou (HTTP 400,
    code "tool_use_failed"). É um glitch transitório de geração — o chamador
    pode tentar de novo ou degradar com elegância."""


class LLMClient:
    def __init__(self):
        self.model = config.GROQ_MODEL
        self.client = Groq(api_key=config.GROQ_API_KEY)

    async def complete(self, messages: List[ChatMessage]) -> Tuple[str, int]:
        """Chat completion sem ferramentas. Retorna (texto, tokens)."""
        return await asyncio.to_thread(self.complete_sync, messages)

    def complete_sync(self, messages: List[ChatMessage]) -> Tuple[str, int]:
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                max_tokens=config.LLM_MAX_TOKENS,
                temperature=config.LLM_TEMPERATURE,
            )
        except groq.RateLimitError:
            raise RuntimeError("Limite de requisições do Groq atingido. Tente novamente em instantes.")
        except groq.APIConnectionError:
            raise RuntimeError("Falha de conexão com o Groq.")
        except groq.APIError as e:
            raise RuntimeError(f"Erro do Groq: {e}")

        text = resp.choices[0].message.content or ""
        return text, _tokens(resp)

    def complete_with_tools(self, messages: list, tools: list) -> ChatCompletion:
        """Chamada com tool definitions. Retorna o objeto bruto da completion
        para o chamador inspecionar `tool_calls`. Síncrona — o SkilledAgent roda
        o loop inteiro dentro de `asyncio.to_thread`."""
        try:
            return self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=1024,
                temperature=0.3,  # temperatura baixa para precisão em pedidos
            )
        except groq.RateLimitError:
            raise RuntimeError("Limite de requisições do Groq atingido. Tente novamente em instantes.")
        except groq.APIConnectionError:
            raise RuntimeError("Falha de conexão com o Groq.")
        except groq.BadRequestError as e:
            body = getattr(e, "body", None) or {}
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("code") == "tool_use_failed":
                log.warning("Groq tool_use_failed: %s", err.get("failed_generation", ""))
                raise ToolUseFailedError("O modelo gerou uma chamada de ferramenta malformada.")
            raise RuntimeError(f"Erro do Groq: {e}")
        except groq.APIError as e:
            raise RuntimeError(f"Erro do Groq: {e}")


_singleton: LLMClient | None = None


def get_llm() -> LLMClient:
    """Instância única do cliente, criada no primeiro uso."""
    global _singleton
    if _singleton is None:
        _singleton = LLMClient()
    return _singleton


def _tokens(resp) -> int:
    usage = getattr(resp, "usage", None)
    if not usage:
        return 0
    return (usage.prompt_tokens or 0) + (usage.completion_tokens or 0)
