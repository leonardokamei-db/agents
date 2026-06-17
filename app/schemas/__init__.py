"""Pacote de schemas Pydantic, um módulo por domínio (espelha os routers).

Re-exporta tudo para preservar os imports existentes `from app.schemas import X`.
"""

from app.schemas.agent import AgentCreate, AgentCreated, AgentPublic, AgentUpdate
from app.schemas.chat import ChatRequest, ChatResponse, Message
from app.schemas.knowledge import TextIngest
from app.schemas.product import ProductCreate, ProductInfo, ProductUpdate
from app.schemas.shared import ProductMode

__all__ = [
    "AgentCreate", "AgentUpdate", "AgentPublic", "AgentCreated",
    "Message", "ChatRequest", "ChatResponse",
    "ProductCreate", "ProductUpdate", "ProductInfo",
    "TextIngest",
    "ProductMode",
]
