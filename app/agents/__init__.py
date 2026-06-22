"""Agentes.

Com o modelo de skills sobrou um único agente de conversa — o `SkilledAgent`
(flexível, dirigido por skills via function calling) — mais o `FallbackAgent`
estático (limite de turnos / erro, precisa funcionar mesmo com o LLM fora).

Os antigos agentes por intenção (FAQ/Order/Support/Clarification) deixaram de
existir: viraram skills (app.skills) que o SkilledAgent invoca.
"""

from app.agents.base import BaseAgent
from app.agents.fallback import FallbackAgent
from app.agents.skilled import SkilledAgent

__all__ = [
    "BaseAgent",
    "FallbackAgent",
    "SkilledAgent",
]
