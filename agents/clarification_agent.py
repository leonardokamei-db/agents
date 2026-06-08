"""ClarificationAgent: when intent is ambiguous (low classifier confidence), ask
ONE focused clarifying question instead of guessing at an answer.
"""

from typing import List

from agents.base import BaseAgent


class ClarificationAgent(BaseAgent):
    source = "llm"

    def fetch_context(self, user_message: str, history: List[dict]) -> dict:
        system_prompt = (
            self.tenant["system_prompt"]
            + "\n\nVocê está no MODO ESCLARECIMENTO. A intenção do cliente está ambígua. "
            "NÃO tente responder ou resolver ainda. Em vez disso, faça UMA única pergunta "
            "de esclarecimento, curta e objetiva, para entender exatamente o que ele "
            "precisa. Responda apenas com a pergunta, em português."
        )
        return {"system_prompt": system_prompt}
