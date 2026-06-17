"""ProductService: regra de negócio de produtos sobre o catalog (ponto 12).

GET funciona em qualquer modo (interno lê o SQLite; externo consulta a API do
cliente). Escrita só faz sentido no modo "internal" — a checagem mora aqui, não
no router.
"""

from __future__ import annotations  # anotações lazy (3.12): `def list` não quebra list[...]

from app import catalog
from app.domain import AgentConfig
from app.errors import NotFoundError, ValidationError


class ProductService:
    def list(self, agent: AgentConfig) -> list[dict]:
        return catalog.list_products(agent)

    def create(self, agent: AgentConfig, data: dict) -> dict:
        self._require_internal(agent)
        return catalog.create_product(agent.id, data)

    def update(self, agent: AgentConfig, product_id: int, changes: dict) -> dict:
        self._require_internal(agent)
        product = catalog.update_product(agent.id, product_id, changes)
        if product is None:
            raise NotFoundError("Produto não encontrado.")
        return product

    def delete(self, agent: AgentConfig, product_id: int) -> None:
        self._require_internal(agent)
        if not catalog.delete_product(agent.id, product_id):
            raise NotFoundError("Produto não encontrado.")

    @staticmethod
    def _require_internal(agent: AgentConfig) -> None:
        if agent.product_mode != "internal":
            raise ValidationError(
                f"Este agente não usa catálogo interno (product_mode={agent.product_mode!r}). "
                "Mude o modo na configuração para gerenciar produtos aqui."
            )
