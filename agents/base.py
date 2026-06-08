"""BaseAgent: the contract + a default LLM execution flow shared by subclasses."""

from typing import List, Optional, Tuple


class BaseAgent:
    # Default provenance reported in the response. Subclasses may override.
    source = "llm"

    def __init__(self, tenant_config: dict, llm_client):
        self.tenant = tenant_config
        self.llm = llm_client

    def fetch_context(self, user_message: str, history: List[dict]) -> dict:
        """Return a dict with at least a `system_prompt` key (and any extra context)."""
        raise NotImplementedError

    def build_prompt(self, context: dict, user_message: str, history: List[dict]) -> List[dict]:
        """Build the final messages list for the LLM call (system + history + user)."""
        messages = [{"role": "system", "content": context["system_prompt"]}]
        messages.extend({"role": m["role"], "content": m["content"]} for m in history)
        messages.append({"role": "user", "content": user_message})
        return messages

    def parse_handoff(self, text: str) -> Tuple[bool, str, Optional[str]]:
        """Detect the [HANDOFF] token and return (should_handoff, clean_text, reason)."""
        text = text.strip()
        should_handoff = "[HANDOFF]" in text
        clean = text.replace("[HANDOFF]", "").strip()
        reason = None
        if should_handoff:
            reason = "O assistente encaminhou para um atendente humano."
            if not clean:
                clean = "Vou transferir você para um atendente humano para ajudar com isso."
        return should_handoff, clean, reason

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        """Default flow: fetch context, build prompt, call LLM, parse handoff."""
        context = self.fetch_context(user_message, history)
        messages = self.build_prompt(context, user_message, history)
        text, tokens = await self.llm.complete(messages)
        should_handoff, clean, reason = self.parse_handoff(text)
        return {
            "response": clean,
            "should_handoff": should_handoff,
            "handoff_reason": reason,
            "source": self.source,
            "tokens_used": tokens,
        }
