"""Modelos Pydantic da API."""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

ProductMode = Literal["none", "internal", "external"]


# --- Agentes (tenants) ------------------------------------------------------- #

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


# --- Chat --------------------------------------------------------------------- #

class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[Message] = []
    conversation_id: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    should_handoff: bool
    handoff_reason: Optional[str] = None
    intent: str
    agent_used: str
    source: str
    confidence: Optional[float] = None
    tokens_used: int = 0
    tools_called: List[str] = []
    rag_chunks_used: int = 0
    rag_sources: List[str] = []
    error: Optional[str] = None


# --- Produtos ------------------------------------------------------------------ #

class ProductCreate(BaseModel):
    name: str
    description: str = ""
    price: float
    stock: int = 0
    unit: str = "unidade"


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = None
    stock: Optional[int] = None
    unit: Optional[str] = None


class ProductInfo(BaseModel):
    id: int
    name: str
    description: str = ""
    price: float
    stock: int = 0
    unit: str = "unidade"


# --- Base de conhecimento -------------------------------------------------------- #

class TextIngest(BaseModel):
    source_name: str
    text: str
