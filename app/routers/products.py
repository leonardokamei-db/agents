"""Produtos por agente.

GET funciona em qualquer modo (interno lê o SQLite; externo consulta a API do
cliente). As rotas de escrita só fazem sentido no modo "internal".
"""

from typing import List

from fastapi import APIRouter, Depends

from app import catalog
from app.domain import AgentConfig
from app.errors import NotFoundError, ValidationError
from app.routers.deps import require_agent
from app.schemas import ProductCreate, ProductInfo, ProductUpdate

router = APIRouter(prefix="/v1/agents/{agent_id}/products", tags=["products"])


def _require_internal(agent: AgentConfig) -> None:
    if agent.product_mode != "internal":
        raise ValidationError(
            "Este agente não usa catálogo interno "
            f"(product_mode={agent.product_mode!r}). "
            "Mude o modo em /config para gerenciar produtos aqui."
        )


@router.get("", response_model=List[ProductInfo])
def list_products(agent: AgentConfig = Depends(require_agent)):
    return catalog.list_products(agent)


@router.post("", response_model=ProductInfo, status_code=201)
def create_product(payload: ProductCreate, agent: AgentConfig = Depends(require_agent)):
    _require_internal(agent)
    return catalog.create_product(agent.id, payload.model_dump())


@router.put("/{product_id}", response_model=ProductInfo)
def update_product(product_id: int, payload: ProductUpdate,
                   agent: AgentConfig = Depends(require_agent)):
    _require_internal(agent)
    product = catalog.update_product(agent.id, product_id, payload.model_dump(exclude_unset=True))
    if product is None:
        raise NotFoundError("Produto não encontrado.")
    return product


@router.delete("/{product_id}")
def delete_product(product_id: int, agent: AgentConfig = Depends(require_agent)):
    _require_internal(agent)
    if not catalog.delete_product(agent.id, product_id):
        raise NotFoundError("Produto não encontrado.")
    return {"deleted": product_id}
