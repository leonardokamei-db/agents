"""Tools (function calling do Groq) via um registry — schema e implementação
saem da MESMA fonte (ponto 17).

Antes, adicionar uma tool exigia editar a lista PRODUCT_TOOLS (schema JSON cru)
E o if/elif de execute_tool, com risco de dessincronizar; os args chegavam como
dict não tipado e só estouravam KeyError em runtime.

Agora: cada tool é registrada com `@tool(...)` informando um modelo Pydantic de
argumentos. PRODUCT_TOOLS é derivado do registry (schema vem do Pydantic) e
execute_tool valida os args com `model_validate` antes de chamar o handler.
Mantém a stack atual (Groq direto) — sem LangGraph.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from app import catalog
from app.domain import AgentConfig

log = logging.getLogger("blip-agent.tools")


# --- Modelos de argumentos (tipados, validados) ----------------------------- #

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


# --- Registry --------------------------------------------------------------- #

@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args_model: type[BaseModel]
    handler: Callable[[AgentConfig, BaseModel], Any]

    def to_groq_schema(self) -> dict:
        schema = self.args_model.model_json_schema()
        schema.pop("title", None)
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": schema,
            },
        }


REGISTRY: dict[str, Tool] = {}


def tool(name: str, description: str, args_model: type[BaseModel]):
    def decorator(fn: Callable[[AgentConfig, BaseModel], Any]):
        REGISTRY[name] = Tool(name, description, args_model, fn)
        return fn
    return decorator


# --- Handlers (uma fonte para schema + dispatch) ---------------------------- #

@tool("check_stock",
      "Verifica estoque e preço total de um produto para uma quantidade.",
      CheckStockArgs)
def _check_stock(agent: AgentConfig, args: CheckStockArgs):
    return catalog.check_stock(agent, args.product_name, args.quantity)


@tool("search_products",
      "Busca produtos por nome ou descrição quando o nome exato é incerto.",
      SearchProductsArgs)
def _search_products(agent: AgentConfig, args: SearchProductsArgs):
    return catalog.search_products(agent, args.query)


@tool("list_products",
      "Lista todos os produtos do catálogo com preço e estoque.",
      ListProductsArgs)
def _list_products(agent: AgentConfig, args: ListProductsArgs):
    return catalog.list_products(agent)


@tool("reserve_stock",
      "Reserva estoque de um pedido. Use APENAS após confirmação explícita de compra.",
      ReserveStockArgs)
def _reserve_stock(agent: AgentConfig, args: ReserveStockArgs):
    return catalog.reserve_stock(agent, args.product_name, args.quantity)


# Definições passadas ao LLM — derivadas do registry (nunca dessincroniza).
PRODUCT_TOOLS = [t.to_groq_schema() for t in REGISTRY.values()]


def execute_tool(tool_name: str, tool_args: dict, agent: AgentConfig) -> str:
    """Valida os args com Pydantic e despacha para o handler. Retorna JSON."""
    log.info("tool: %s(%s) agent=%s", tool_name, tool_args, agent.id)
    entry = REGISTRY.get(tool_name)
    if entry is None:
        return json.dumps({"error": f"Ferramenta desconhecida: {tool_name}"}, ensure_ascii=False)
    try:
        args = entry.args_model.model_validate(tool_args or {})
    except ValidationError as e:
        return json.dumps(
            {"error": f"Argumentos inválidos para {tool_name}: {e.errors()}"},
            ensure_ascii=False, default=str,
        )
    result = entry.handler(agent, args)
    return json.dumps(result, ensure_ascii=False)
