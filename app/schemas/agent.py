"""Schemas de agentes. O agente pertence a um tenant; a credencial vive no
tenant (não há api_key por agente). `slug` é o segmento de rota dentro do
tenant; `id` é a PK opaca global."""

from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.shared import ProductMode


class AgentCreate(BaseModel):
    slug: Optional[str] = Field(default=None, description="Slug dentro do tenant (gerado do nome se omitido)")
    name: str
    system_prompt: str = ""          # vazio -> usa o prompt padrão compacto
    business_rules: str = ""
    max_turns: int = 15
    product_mode: ProductMode = "none"
    product_api_url: str = ""
    product_api_key: str = ""
    rag_enabled: bool = True
    external_products: bool = True


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    business_rules: Optional[str] = None
    max_turns: Optional[int] = None
    product_mode: Optional[ProductMode] = None
    product_api_url: Optional[str] = None
    product_api_key: Optional[str] = None
    rag_enabled: Optional[bool] = None
    external_products: Optional[bool] = None


class AgentPublic(BaseModel):
    """Configuração visível do agente (sem segredos)."""
    id: str
    tenant_id: str
    slug: str
    name: str
    system_prompt: str
    business_rules: str
    max_turns: int
    product_mode: ProductMode
    product_api_url: str
    rag_enabled: bool
    external_products: bool
    endpoint: str  # ex.: /v1/tenants/acme/agents/loja/chat
    created_at: str
