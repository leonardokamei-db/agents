"""Camada de acesso a dados. Todo SQL cru vive AQUI — nenhum outro módulo abre
conexão nem escreve query. As classes retornam tipos de domínio (Tenant, User,
Membership, AgentConfig, ProductRow) e forçam o escopo por tenant/agente."""

from app.repositories.agents import AgentRepository
from app.repositories.products import ProductRepository
from app.repositories.tenants import (
    MembershipRepository,
    TenantRepository,
    UserRepository,
)

__all__ = [
    "AgentRepository",
    "ProductRepository",
    "TenantRepository",
    "UserRepository",
    "MembershipRepository",
]
