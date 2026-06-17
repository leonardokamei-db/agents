"""Camada de services (ponto 12): regra de negócio entre os routers e os
repositórios/domínio. Os routers só fazem HTTP↔service; nenhuma lógica de
negócio ou SQL vive neles.

Os serviços são stateless (só seguram repositórios), então expomos singletons e
getters `get_*_service` para injeção via `Depends` nos routers.
"""

from app.services.agents import AgentService
from app.services.knowledge import KnowledgeService
from app.services.products import ProductService
from app.services.tenants import TenantService

_agent_service = AgentService()
_tenant_service = TenantService()
_product_service = ProductService()
_knowledge_service = KnowledgeService()


def get_agent_service() -> AgentService:
    return _agent_service


def get_tenant_service() -> TenantService:
    return _tenant_service


def get_product_service() -> ProductService:
    return _product_service


def get_knowledge_service() -> KnowledgeService:
    return _knowledge_service


__all__ = [
    "AgentService", "TenantService", "ProductService", "KnowledgeService",
    "get_agent_service", "get_tenant_service",
    "get_product_service", "get_knowledge_service",
]
