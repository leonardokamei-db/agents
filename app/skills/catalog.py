"""Skills de catálogo (as antigas tools do OrderAgent + a nova check_catalog).

Cada skill consulta o catálogo do agente — interno (SQLite) ou externo (API REST
do cliente) — via `app.catalog`, que abstrai a fonte. O modelo NUNCA inventa
preço/estoque: tudo vem destas skills.

  * check_stock      — estoque e preço total de um produto.
  * search_products  — busca produtos por nome/descrição.
  * list_products    — lista o catálogo.
  * reserve_stock    — reserva (só interno); sucesso => handoff p/ pagamento.
  * check_catalog    — verifica o catálogo do cliente (configuração + acesso).
                       É a skill nova: diagnostica a integração antes de operar.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app import catalog
from app.skills.base import (
    CATEGORY_CATALOG,
    SkillContext,
    SkillResult,
    skill,
)


class CheckStockArgs(BaseModel):
    product_name: str
    quantity: int


class SearchProductsArgs(BaseModel):
    query: str


class ListProductsArgs(BaseModel):
    pass


class ReserveStockArgs(BaseModel):
    product_name: str
    quantity: int


class CheckCatalogArgs(BaseModel):
    pass


@skill("check_stock",
       "Verifica estoque e preço total de um produto para uma quantidade.",
       CheckStockArgs, category=CATEGORY_CATALOG)
def _check_stock(ctx: SkillContext, args: CheckStockArgs) -> SkillResult:
    return SkillResult(data=catalog.check_stock(ctx.agent, args.product_name, args.quantity))


@skill("search_products",
       "Busca produtos por nome ou descrição quando o nome exato é incerto.",
       SearchProductsArgs, category=CATEGORY_CATALOG)
def _search_products(ctx: SkillContext, args: SearchProductsArgs) -> SkillResult:
    return SkillResult(data=catalog.search_products(ctx.agent, args.query))


@skill("list_products",
       "Lista todos os produtos do catálogo com preço e estoque.",
       ListProductsArgs, category=CATEGORY_CATALOG)
def _list_products(ctx: SkillContext, args: ListProductsArgs) -> SkillResult:
    return SkillResult(data=catalog.list_products(ctx.agent))


@skill("check_catalog",
       "Verifica o catálogo do cliente: como está configurado (interno/externo) "
       "e se está acessível. Use para diagnosticar a integração de produtos.",
       CheckCatalogArgs, category=CATEGORY_CATALOG)
def _check_catalog(ctx: SkillContext, args: CheckCatalogArgs) -> SkillResult:
    return SkillResult(data=catalog.catalog_health(ctx.agent))


@skill("reserve_stock",
       "Reserva estoque de um pedido. Use APENAS após confirmação explícita de compra.",
       ReserveStockArgs, category=CATEGORY_CATALOG)
def _reserve_stock(ctx: SkillContext, args: ReserveStockArgs) -> SkillResult:
    result = catalog.reserve_stock(ctx.agent, args.product_name, args.quantity)
    # Reserva concluída == compra registrada -> encaminhar a um humano para o
    # pagamento (handoff). Falha de validação (produto inexistente/qtd inválida)
    # NÃO faz handoff: o modelo ainda pode esclarecer com o cliente.
    if result.get("success"):
        return SkillResult(data=result, handoff=True,
                           handoff_reason="Pedido confirmado — encaminhar para pagamento.")
    return SkillResult(data=result)
