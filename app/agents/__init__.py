"""Agentes especializados. Cada um é um system prompt compacto + lógica de
contexto — não um processo separado."""

from app.agents.base import BaseAgent
from app.agents.clarification import ClarificationAgent
from app.agents.fallback import FallbackAgent
from app.agents.faq import FAQAgent
from app.agents.order import OrderAgent
from app.agents.support import SupportAgent

__all__ = [
    "BaseAgent",
    "ClarificationAgent",
    "FallbackAgent",
    "FAQAgent",
    "OrderAgent",
    "SupportAgent",
]
