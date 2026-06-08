"""Groq API client wrapper.

The Groq SDK is synchronous, so blocking calls are dispatched to a worker thread
with `asyncio.to_thread` to keep the FastAPI event loop responsive. Rate-limit and
API errors are caught and re-raised as RuntimeError so the Orchestrator can route
them to the FallbackAgent.

Note: `mixtral-8x7b-32768` has been decommissioned by Groq and `groq-3.5-sonnet`
does not exist. The default below is a current, supported Groq model.
"""

import asyncio
import logging
import os
from typing import List, Tuple

import groq
from groq import Groq

log = logging.getLogger("blip-agent.llm")

DEFAULT_MODEL = "llama-3.3-70b-versatile"


class ToolUseFailedError(RuntimeError):
    """Raised when the model emits a malformed tool call and Groq rejects it
    (HTTP 400, code "tool_use_failed"). This is a transient generation glitch,
    NOT a connection/auth failure — the caller can retry or degrade gracefully."""

    def __init__(self, message: str, failed_generation: str = ""):
        super().__init__(message)
        self.failed_generation = failed_generation


class GroqLLMClient:
    def __init__(self, api_key: str = None, model: str = None,
                 max_tokens: int = 512, temperature: float = 0.7):
        self.api_key = api_key or os.getenv("GROQ_API_KEY")
        self.model = model or os.getenv("GROQ_MODEL", DEFAULT_MODEL)
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.client = Groq(api_key=self.api_key)

    async def complete(self, messages: List[dict]) -> Tuple[str, int]:
        """Call the chat-completions endpoint with a fully-built messages list."""
        return await asyncio.to_thread(self._complete_sync, messages)

    async def call(self, system_prompt: str, user_message: str,
                   history: List[dict]) -> Tuple[str, int]:
        """Convenience wrapper: build messages from parts, then complete()."""
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})
        return await self.complete(messages)

    def call_with_tools(self, messages: list, tools: list):
        """Call Groq with tool definitions. Returns the raw completion object so the
        caller can inspect `tool_calls`. Synchronous — the OrderAgent runs the whole
        tool loop inside `asyncio.to_thread` to keep the event loop free."""
        try:
            return self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=1024,
                temperature=0.3,  # lower temp for order accuracy
            )
        except groq.RateLimitError as e:
            log.warning("Groq rate limit (tools): %s", e)
            raise RuntimeError("Limite de requisições do Groq atingido. Tente novamente em instantes.")
        except groq.APIConnectionError as e:
            log.error("Groq connection error (tools): %s", e)
            raise RuntimeError("Falha de conexão com o Groq.")
        except groq.BadRequestError as e:
            # The model sometimes emits malformed tool-call syntax that Groq
            # rejects with code "tool_use_failed". This is recoverable — surface
            # it as a distinct, retryable error instead of a fatal RuntimeError.
            body = getattr(e, "body", None) or {}
            err = body.get("error", {}) if isinstance(body, dict) else {}
            if err.get("code") == "tool_use_failed":
                failed = err.get("failed_generation", "")
                log.warning("Groq tool_use_failed (malformed tool call): %s", failed)
                raise ToolUseFailedError(
                    "O modelo gerou uma chamada de ferramenta malformada.",
                    failed_generation=failed,
                )
            log.error("Groq bad request (tools): %s", e)
            raise RuntimeError(f"Erro do Groq: {e}")
        except groq.APIError as e:
            log.error("Groq API error (tools): %s", e)
            raise RuntimeError(f"Erro do Groq: {e}")

    def _complete_sync(self, messages: List[dict]) -> Tuple[str, int]:
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
            )
        except groq.RateLimitError as e:
            log.warning("Groq rate limit: %s", e)
            raise RuntimeError("Limite de requisições do Groq atingido. Tente novamente em instantes.")
        except groq.APIConnectionError as e:
            log.error("Groq connection error: %s", e)
            raise RuntimeError("Falha de conexão com o Groq.")
        except groq.APIError as e:
            log.error("Groq API error: %s", e)
            raise RuntimeError(f"Erro do Groq: {e}")

        text = resp.choices[0].message.content or ""
        usage = resp.usage
        tokens = (usage.prompt_tokens + usage.completion_tokens) if usage else 0
        return text, tokens
