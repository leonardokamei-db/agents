"""Pacote de schemas Pydantic, um módulo por domínio (espelha os routers).

Re-exporta tudo para preservar os imports existentes `from app.schemas import X`.
"""

from app.schemas.agent import AgentCreate, AgentPublic, AgentUpdate
from app.schemas.chat import ChatRequest, ChatResponse, Message
from app.schemas.knowledge import TextIngest
from app.schemas.product import ProductCreate, ProductInfo, ProductUpdate
from app.schemas.shared import ProductMode
from app.schemas.tenant import (
    MemberCreate,
    MemberCreated,
    MemberInfo,
    TenantCreate,
    TenantCreated,
    TenantPublic,
)

__all__ = [
    "AgentCreate", "AgentUpdate", "AgentPublic",
    "Message", "ChatRequest", "ChatResponse",
    "ProductCreate", "ProductUpdate", "ProductInfo",
    "TextIngest",
    "ProductMode",
    "TenantCreate", "TenantCreated", "TenantPublic",
    "MemberCreate", "MemberCreated", "MemberInfo",
]
