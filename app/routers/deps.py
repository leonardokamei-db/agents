"""Dependências compartilhadas dos routers: autenticação e helpers."""

from typing import Optional

from fastapi import Header, Path

from app import tenants
from app.config import ADMIN_API_KEY
from app.domain import AgentConfig
from app.errors import NotFoundError, UnauthorizedError


def require_admin(x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key")) -> None:
    if x_admin_key != ADMIN_API_KEY:
        raise UnauthorizedError("Chave de administração inválida.")


def require_agent(
    agent_id: str = Path(...),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> AgentConfig:
    """Autentica uma rota por agente. Aceita a api_key do agente ou a chave de
    administração. Retorna o registro do agente."""
    agent = tenants.get_agent(agent_id)
    if agent is None:
        raise NotFoundError(f"Agente '{agent_id}' não encontrado.")
    if not x_api_key or (x_api_key != agent.api_key and x_api_key != ADMIN_API_KEY):
        raise UnauthorizedError("API key inválida para este agente.")
    return agent


def agent_public(agent: AgentConfig) -> dict:
    """Visão pública do agente (sem api_key) + URL do endpoint de chat."""
    return {
        "id": agent.id,
        "name": agent.name,
        "system_prompt": agent.system_prompt,
        "business_rules": agent.business_rules,
        "max_turns": agent.max_turns,
        "product_mode": agent.product_mode,
        "product_api_url": agent.product_api_url,
        "endpoint": f"/v1/agents/{agent.id}/chat",
        "created_at": str(agent.created_at),
    }
