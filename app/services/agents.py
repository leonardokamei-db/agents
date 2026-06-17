"""AgentService: regra de negócio de agentes sobre o AgentRepository (ponto 12).

Criar um agente aqui é o que "abre" o endpoint dele: as rotas resolvem por
(tenant, slug) a cada requisição, então um agente novo responde no mesmo
instante, sem redeploy. A PK é prefixada por tenant (`{tenant}__{slug}`) para
não colidir slug entre tenants (ponto 19).
"""

import logging

from app import rag
from app.domain import AgentConfig
from app.errors import ConflictError, NotFoundError, ValidationError
from app.repositories import AgentRepository
from app.textutil import slugify

log = logging.getLogger("blip-agent.services.agents")


class AgentService:
    def __init__(self, repo: AgentRepository | None = None):
        self._repo = repo or AgentRepository()

    # --- leitura ----------------------------------------------------------- #
    def list_for_tenant(self, tenant_id: str) -> list[AgentConfig]:
        return self._repo.list_for_tenant(tenant_id)

    def list_all(self) -> list[AgentConfig]:
        return self._repo.list_all()

    def get(self, tenant_id: str, slug: str) -> AgentConfig:
        agent = self._repo.get(tenant_id, slug)
        if agent is None:
            raise NotFoundError(f"Agente '{slug}' não encontrado neste tenant.")
        return agent

    # --- escrita ----------------------------------------------------------- #
    def create(self, tenant_id: str, data: dict) -> AgentConfig:
        slug = slugify(data.get("slug") or data["name"], fallback="agente")
        if self._repo.exists(tenant_id, slug):
            raise ConflictError(f"Já existe um agente '{slug}' neste tenant.")
        self._check_external(data.get("product_mode", "none"),
                             data.get("external_products", True))
        agent_id = f"{tenant_id}__{slug}"
        self._repo.insert(agent_id, tenant_id, slug, data)
        log.info("Agente criado: %s (tenant=%s)", agent_id, tenant_id)
        return self._repo.get_by_id(agent_id)

    def update(self, agent: AgentConfig, changes: dict) -> AgentConfig:
        mode = changes.get("product_mode", agent.product_mode)
        ext = changes.get("external_products", agent.external_products)
        self._check_external(mode, ext)
        self._repo.update(agent.id, changes)
        return self._repo.get_by_id(agent.id)

    def delete(self, agent: AgentConfig) -> int:
        """Exclui o agente e a base de conhecimento dele. Produtos saem por
        cascade (FK). Retorna quantos chunks RAG foram removidos."""
        self._repo.delete(agent.id)
        return rag.delete_agent_data(agent.id)

    # --- validação --------------------------------------------------------- #
    @staticmethod
    def _check_external(product_mode: str, external_enabled: bool) -> None:
        if product_mode == "external" and not external_enabled:
            raise ValidationError(
                "Catálogo externo desabilitado para este agente "
                "(feature flag external_products=false)."
            )
