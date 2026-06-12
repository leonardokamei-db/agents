"""BaseAgent: contrato + fluxo padrão de execução com LLM."""

from typing import List, Optional, Tuple

from app.prompts import HANDOFF_TOKEN


class BaseAgent:
    # Proveniência padrão reportada na resposta. Subclasses podem sobrescrever.
    source = "llm"

    def __init__(self, agent_config: dict, llm):
        self.agent = agent_config
        self.llm = llm

    def system_prompt(self, user_message: str) -> str:
        """System prompt do agente para esta mensagem."""
        raise NotImplementedError

    async def execute(self, user_message: str, history: List[dict]) -> dict:
        """Fluxo padrão: prompt -> LLM -> parse de handoff."""
        messages = build_messages(self.system_prompt(user_message), user_message, history)
        text, tokens = await self.llm.complete(messages)
        should_handoff, clean, reason = parse_handoff(text)
        return {
            "response": clean,
            "should_handoff": should_handoff,
            "handoff_reason": reason,
            "source": self.source,
            "tokens_used": tokens,
        }


def build_messages(system_prompt: str, user_message: str, history: List[dict]) -> List[dict]:
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend({"role": m["role"], "content": m["content"]} for m in history)
    messages.append({"role": "user", "content": user_message})
    return messages


def parse_handoff(text: str) -> Tuple[bool, str, Optional[str]]:
    """Detecta o token [HANDOFF] e retorna (should_handoff, texto_limpo, motivo)."""
    text = text.strip()
    should_handoff = HANDOFF_TOKEN in text
    clean = text.replace(HANDOFF_TOKEN, "").strip()
    reason = None
    if should_handoff:
        reason = "O assistente encaminhou para um atendente humano."
        if not clean:
            clean = "Vou transferir você para um atendente humano para ajudar com isso."
    return should_handoff, clean, reason
