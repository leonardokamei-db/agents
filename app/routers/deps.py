"""Dependências dos routers: autenticação, RBAC (ponto 8) e resolução do agente.

Hierarquia de credenciais:
  * ADMIN_API_KEY (X-Admin-Key)  -> admin de plataforma: cria/exclui TENANTS.
  * api_key do tenant (X-API-Key) -> owner do próprio tenant (chave master/consumo).
  * api_key de usuário (X-API-Key) -> papel vindo da membership (owner | member).

`member` tem leitura + chat + conteúdo (knowledge/produtos); `owner`/`admin`
gerenciam agentes e membros.
"""

from typing import Optional

from fastapi import Depends, Header, Path

from app.config import ADMIN_API_KEY
from app.domain import AgentConfig, Principal
from app.errors import ForbiddenError, UnauthorizedError
from app.repositories import MembershipRepository, TenantRepository, UserRepository
from app.services import AgentService, get_agent_service

_tenants = TenantRepository()
_users = UserRepository()
_members = MembershipRepository()


def _resolve_principal(tenant_id: str, x_api_key: Optional[str]) -> Principal:
    if not x_api_key:
        raise UnauthorizedError("Informe a X-API-Key.")
    if x_api_key == ADMIN_API_KEY:
        return Principal(role="admin", tenant_id=tenant_id)
    tenant = _tenants.get_by_api_key(x_api_key)
    if tenant is not None:
        if tenant.id != tenant_id:
            raise ForbiddenError("Chave de tenant não corresponde a este tenant.")
        return Principal(role="owner", tenant_id=tenant_id)
    user = _users.get_by_api_key(x_api_key)
    if user is not None:
        membership = _members.get(tenant_id, user.id)
        if membership is None:
            raise ForbiddenError("Usuário não é membro deste tenant.")
        return Principal(role=membership.role, tenant_id=tenant_id, user_id=user.id)
    raise UnauthorizedError("API key inválida.")


def require_member(
    tenant_id: str = Path(...),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> Principal:
    """Qualquer papel válido no tenant (leitura/chat/conteúdo)."""
    return _resolve_principal(tenant_id, x_api_key)


def require_owner(principal: Principal = Depends(require_member)) -> Principal:
    """Restringe a owners do tenant (e admin de plataforma)."""
    if not principal.can_manage:
        raise ForbiddenError("Ação restrita a owners do tenant.")
    return principal


def require_platform_admin(
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
) -> None:
    """Operações de plataforma (criar/excluir tenants)."""
    if x_admin_key != ADMIN_API_KEY:
        raise UnauthorizedError("Chave de administração inválida.")


def resolve_agent(
    tenant_id: str = Path(...),
    agent_slug: str = Path(...),
    agents: AgentService = Depends(get_agent_service),
) -> AgentConfig:
    """Resolve o agente pelo par (tenant, slug) do path (404 se não existir)."""
    return agents.get(tenant_id, agent_slug)


def agent_public(agent: AgentConfig) -> dict:
    """Visão pública do agente (sem segredos) + URL do endpoint de chat."""
    return {
        "id": agent.id,
        "tenant_id": agent.tenant_id,
        "slug": agent.slug,
        "name": agent.name,
        "system_prompt": agent.system_prompt,
        "business_rules": agent.business_rules,
        "max_turns": agent.max_turns,
        "product_mode": agent.product_mode,
        "product_api_url": agent.product_api_url,
        "rag_enabled": agent.rag_enabled,
        "external_products": agent.external_products,
        "endpoint": f"/v1/tenants/{agent.tenant_id}/agents/{agent.slug}/chat",
        "created_at": str(agent.created_at),
    }
