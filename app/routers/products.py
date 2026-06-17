"""Produtos por agente (aninhado sob o tenant).

GET funciona em qualquer modo (interno lê o SQLite; externo consulta a API do
cliente). As regras de escrita (só no modo "internal") moram no ProductService.
"""

from typing import List

from fastapi import APIRouter, Depends

from app.domain import AgentConfig
from app.routers.deps import require_member, resolve_agent
from app.schemas import ProductCreate, ProductInfo, ProductUpdate
from app.services import ProductService, get_product_service

router = APIRouter(
    prefix="/v1/tenants/{tenant_id}/agents/{agent_slug}/products",
    tags=["products"],
    dependencies=[Depends(require_member)],
)


@router.get("", response_model=List[ProductInfo])
def list_products(agent: AgentConfig = Depends(resolve_agent),
                  svc: ProductService = Depends(get_product_service)):
    return svc.list(agent)


@router.post("", response_model=ProductInfo, status_code=201)
def create_product(payload: ProductCreate, agent: AgentConfig = Depends(resolve_agent),
                   svc: ProductService = Depends(get_product_service)):
    return svc.create(agent, payload.model_dump())


@router.put("/{product_id}", response_model=ProductInfo)
def update_product(product_id: int, payload: ProductUpdate,
                   agent: AgentConfig = Depends(resolve_agent),
                   svc: ProductService = Depends(get_product_service)):
    return svc.update(agent, product_id, payload.model_dump(exclude_unset=True))


@router.delete("/{product_id}")
def delete_product(product_id: int, agent: AgentConfig = Depends(resolve_agent),
                   svc: ProductService = Depends(get_product_service)):
    svc.delete(agent, product_id)
    return {"deleted": product_id}
