"""Schemas de agentes (tenants)."""

from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.shared import ProductMode


class AgentCreate(BaseModel):
    id: Optional[str] = Field(default=None, description="Slug do agente (gerado a partir do nome se omitido)")
    name: str
    system_prompt: str = ""          # vazio -> usa o prompt padrão compacto
    business_rules: str = ""
    max_turns: int = 15
    product_mode: ProductMode = "none"
    product_api_url: str = ""
    product_api_key: str = ""


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    business_rules: Optional[str] = None
    max_turns: Optional[int] = None
    product_mode: Optional[ProductMode] = None
    product_api_url: Optional[str] = None
    product_api_key: Optional[str] = None


class AgentPublic(BaseModel):
    """Configuração visível do agente (sem api_key)."""
    id: str
    name: str
    system_prompt: str
    business_rules: str
    max_turns: int
    product_mode: ProductMode
    product_api_url: str
    endpoint: str  # ex.: /v1/agents/minha-loja/chat
    created_at: str


class AgentCreated(AgentPublic):
    """Retornado apenas na criação — inclui a api_key gerada."""
    api_key: str
