"""ClarificationAgent: intenção ambígua -> faz UMA pergunta de esclarecimento."""

from app.agents.base import BaseAgent
from app.prompts import clarification_prompt


class ClarificationAgent(BaseAgent):
    source = "llm"

    def system_prompt(self, user_message: str) -> str:
        return clarification_prompt(self.agent)
