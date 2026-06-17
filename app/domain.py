"""Tipos de domínio compartilhados — elimina dicts opacos e magic strings.

Centraliza os contratos que antes eram `dict` solto espalhado pelo projeto:

  * ChatMessage  — mensagem trocada com o LLM ({role, content}).
  * AgentConfig  — configuração de um agente, tipada (substitui agent["..."]).
  * ProductRow   — produto vindo do catálogo interno OU externo (shape único).
  * AgentResult  — saída padronizada de todo agente (substitui o dict de retorno).

Notas de design:
  * AgentResult é a saída do AGENTE. O contrato final da API (ChatResponse) é
    diferente: ele inclui intent/agent_used/confidence, que NÃO são produzidos
    pelos agentes e sim injetados pelo Orchestrator. Por isso AgentResult não os
    carrega — o orchestrator os adiciona em OrchestratorResult.to_response_dict.
  * from_row aceita sqlite3.Row OU dict (mesma interface de acesso por chave),
    então serve tanto para a camada de dados quanto para a API externa.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Mapping, Optional, TypedDict

Role = Literal["system", "user", "assistant", "tool"]
ProductMode = Literal["none", "internal", "external"]
MemberRole = Literal["owner", "member"]


class ChatMessage(TypedDict):
    """Mensagem no formato esperado pelo SDK do Groq."""
    role: Role
    content: str


@dataclass(frozen=True)
class Tenant:
    """Cliente da plataforma — dono de N agentes (ponto 19).

    A credencial de consumo/gerência sobe para este nível: `api_key` é a chave
    master do tenant (papel owner sobre seus agentes). Substitui a antiga
    api_key por agente.
    """
    id: str
    name: str
    api_key: str
    created_at: str = ""

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Tenant":
        return cls(
            id=row["id"],
            name=row["name"],
            api_key=row["api_key"],
            created_at=str(row["created_at"]) if row["created_at"] is not None else "",
        )


@dataclass(frozen=True)
class User:
    """Usuário da plataforma. Autentica por `api_key`; o papel vem da membership."""
    id: str
    email: str
    name: str = ""
    api_key: str = ""
    created_at: str = ""

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "User":
        return cls(
            id=row["id"],
            email=row["email"],
            name=row["name"] or "",
            api_key=row["api_key"],
            created_at=str(row["created_at"]) if row["created_at"] is not None else "",
        )


@dataclass(frozen=True)
class Membership:
    """Vínculo usuário↔tenant com papel (RBAC mínimo — ponto 8)."""
    tenant_id: str
    user_id: str
    role: MemberRole = "member"

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Membership":
        return cls(tenant_id=row["tenant_id"], user_id=row["user_id"], role=row["role"])


@dataclass(frozen=True)
class Principal:
    """Quem está fazendo a requisição, já resolvido (ponto 8).

    `role` rege o RBAC: "admin" (plataforma) e "owner" têm controle total no
    escopo; "member" tem leitura + chat + conteúdo, sem gerir agentes/membros.
    """
    role: Literal["admin", "owner", "member"]
    tenant_id: Optional[str] = None
    user_id: Optional[str] = None

    @property
    def can_manage(self) -> bool:
        """Pode criar/excluir agentes e gerir membros."""
        return self.role in ("admin", "owner")


@dataclass(frozen=True)
class AgentConfig:
    """Configuração de um agente, tipada. Espelha a tabela `agents`.

    `id` é a PK opaca e globalmente única (novos agentes nascem `{tenant}__{slug}`,
    o que resolve colisão de slug entre tenants — ponto 19). O caminho da API usa
    o `slug` dentro do tenant. Sem `api_key`: a credencial vive no tenant.
    """
    id: str
    tenant_id: str
    slug: str
    name: str
    system_prompt: str = ""
    business_rules: str = ""
    max_turns: int = 15
    product_mode: ProductMode = "none"
    product_api_url: str = ""
    product_api_key: str = ""
    rag_enabled: bool = True
    external_products: bool = True
    created_at: str = ""

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "AgentConfig":
        return cls(
            id=row["id"],
            tenant_id=row["tenant_id"],
            slug=row["slug"],
            name=row["name"],
            system_prompt=row["system_prompt"] or "",
            business_rules=row["business_rules"] or "",
            max_turns=row["max_turns"],
            product_mode=row["product_mode"],
            product_api_url=row["product_api_url"] or "",
            product_api_key=row["product_api_key"] or "",
            rag_enabled=bool(row["rag_enabled"]),
            external_products=bool(row["external_products"]),
            created_at=str(row["created_at"]) if row["created_at"] is not None else "",
        )


@dataclass
class ProductRow:
    """Produto normalizado — mesmo shape para catálogo interno e API externa."""
    id: int
    name: str
    description: str = ""
    price: float = 0.0
    stock: int = 0
    unit: str = "unidade"

    @classmethod
    def from_db_row(cls, row: "sqlite3.Row") -> "ProductRow":
        """Linha do SQLite (todas as colunas presentes — acesso direto por chave)."""
        return cls(
            id=row["id"],
            name=row["name"],
            description=row["description"] or "",
            price=row["price"],
            stock=row["stock"],
            unit=row["unit"] or "unidade",
        )

    @classmethod
    def from_external(cls, p: Mapping[str, Any], fallback_id: int = 0) -> "ProductRow":
        """Item da API externa do cliente (campos podem faltar — usa defaults)."""
        return cls(
            id=int(p.get("id", fallback_id) or fallback_id),
            name=str(p.get("name", "")),
            description=str(p.get("description", "") or ""),
            price=float(p.get("price", 0) or 0),
            stock=int(p.get("stock", 0) or 0),
            unit=str(p.get("unit", "unidade") or "unidade"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AgentResult:
    """Saída padronizada de qualquer agente (antes era um dict solto).

    Campos opcionais cobrem fluxos específicos (RAG no FAQAgent, tools no
    OrderAgent) com defaults, então toda subclasse satisfaz o contrato mínimo.
    """
    response: str
    should_handoff: bool = False
    handoff_reason: Optional[str] = None
    source: str = "llm"
    tokens_used: int = 0
    tools_called: list[str] = field(default_factory=list)
    rag_chunks_used: int = 0
    rag_sources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)
