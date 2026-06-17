"""TenantService: ciclo de vida de tenants, usuários e memberships (pontos 19, 8).

Criar um tenant cria também seu primeiro usuário OWNER. A api_key do tenant é a
credencial de consumo/master; usuários autenticam pela própria api_key e o papel
vem da membership (owner/member).
"""

import logging
import secrets

from app import rag
from app.config import DEFAULT_TENANT_ID
from app.db import ensure_default_tenant
from app.domain import Membership, Tenant, User
from app.errors import ConflictError, NotFoundError, ValidationError
from app.repositories import (
    AgentRepository,
    MembershipRepository,
    TenantRepository,
    UserRepository,
)
from app.textutil import slugify

log = logging.getLogger("blip-agent.services.tenants")


def _new_key(prefix: str) -> str:
    return f"blip-{prefix}-{secrets.token_urlsafe(24)}"


class TenantService:
    def __init__(self):
        self._tenants = TenantRepository()
        self._users = UserRepository()
        self._members = MembershipRepository()
        self._agents = AgentRepository()

    # --- tenants ----------------------------------------------------------- #
    def list(self) -> list[Tenant]:
        return self._tenants.list()

    def get(self, tenant_id: str) -> Tenant:
        tenant = self._tenants.get(tenant_id)
        if tenant is None:
            raise NotFoundError(f"Tenant '{tenant_id}' não encontrado.")
        return tenant

    def create(self, data: dict) -> tuple[Tenant, User]:
        """Cria o tenant + o primeiro usuário owner. Retorna (tenant, owner)."""
        tenant_id = slugify(data.get("id") or data["name"], fallback="tenant")
        if self._tenants.exists(tenant_id):
            raise ConflictError(f"Já existe um tenant com id '{tenant_id}'.")
        self._tenants.insert(tenant_id, data["name"], _new_key("tenant"))
        owner = self._ensure_user(data["owner_email"], data.get("owner_name", ""))
        self._members.upsert(tenant_id, owner.id, "owner")
        log.info("Tenant criado: %s (owner=%s)", tenant_id, owner.email)
        return self._tenants.get(tenant_id), owner

    def delete(self, tenant_id: str) -> dict:
        """Exclui o tenant. Agentes/produtos/memberships saem por cascade (FK);
        os dados RAG de cada agente são removidos explicitamente (banco à parte)."""
        if not self._tenants.exists(tenant_id):
            raise NotFoundError(f"Tenant '{tenant_id}' não encontrado.")
        chunks = sum(rag.delete_agent_data(a.id)
                     for a in self._agents.list_for_tenant(tenant_id))
        self._tenants.delete(tenant_id)
        return {"deleted": tenant_id, "deleted_chunks": chunks}

    # --- membros ----------------------------------------------------------- #
    def list_members(self, tenant_id: str) -> list[dict]:
        out = []
        for m in self._members.list_for_tenant(tenant_id):
            user = self._users.get(m.user_id)
            out.append({"user_id": m.user_id, "role": m.role,
                        "email": user.email if user else "", "name": user.name if user else ""})
        return out

    def add_member(self, tenant_id: str, email: str, role: str, name: str = "") -> dict:
        if role not in ("owner", "member"):
            raise ValidationError("Papel inválido (use 'owner' ou 'member').")
        user = self._ensure_user(email, name)
        self._members.upsert(tenant_id, user.id, role)
        log.info("Membership %s -> %s (%s)", email, tenant_id, role)
        return {"user_id": user.id, "email": user.email, "role": role,
                "api_key": user.api_key}

    def remove_member(self, tenant_id: str, user_id: str) -> None:
        membership = self._members.get(tenant_id, user_id)
        if membership is None:
            raise NotFoundError("Membership não encontrada.")
        if membership.role == "owner" and self._members.count_owners(tenant_id) <= 1:
            raise ValidationError("Não é possível remover o último owner do tenant.")
        self._members.delete(tenant_id, user_id)

    def membership_of(self, tenant_id: str, user_id: str) -> Membership | None:
        return self._members.get(tenant_id, user_id)

    # --- bootstrap --------------------------------------------------------- #
    def ensure_default_tenant(self) -> Tenant:
        ensure_default_tenant()
        return self._tenants.get(DEFAULT_TENANT_ID)

    # --- internos ---------------------------------------------------------- #
    def _ensure_user(self, email: str, name: str) -> User:
        existing = self._users.get_by_email(email)
        if existing:
            return existing
        user_id = f"usr-{secrets.token_urlsafe(8)}"
        self._users.insert(user_id, email, name, _new_key("user"))
        return self._users.get(user_id)
