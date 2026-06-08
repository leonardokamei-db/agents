"""Groq tool (function-calling) schemas + a dispatcher that runs them against
the SQLite product database.

These tool definitions are passed to the LLM via `tool_choice="auto"`. When the
model decides to call one, the OrderAgent dispatches it through `execute_tool`,
which returns a JSON string fed back to the model as a `tool` message.
"""

import json
import logging

from database import check_stock, list_products, reserve_stock, search_products

log = logging.getLogger("blip-agent.tools")

PRODUCT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_stock",
            "description": (
                "Verifica se um produto está disponível em estoque e calcula o preço "
                "total para uma quantidade solicitada."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "product_name": {
                        "type": "string",
                        "description": "Nome do produto a verificar",
                    },
                    "quantity": {
                        "type": "integer",
                        "description": "Quantidade desejada pelo cliente",
                    },
                },
                "required": ["product_name", "quantity"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_products",
            "description": (
                "Busca produtos no catálogo por nome ou descrição. Use quando o cliente "
                "perguntar quais produtos existem ou quando não tiver certeza do nome exato."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Termo de busca",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_products",
            "description": (
                "Lista todos os produtos disponíveis no catálogo com preços e estoque atual."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reserve_stock",
            "description": (
                "Confirma um pedido e reserva o estoque. Use APENAS quando o cliente "
                "confirmar explicitamente que quer comprar."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "product_name": {"type": "string"},
                    "quantity": {"type": "integer"},
                },
                "required": ["product_name", "quantity"],
            },
        },
    },
]


def execute_tool(tool_name: str, tool_args: dict, tenant_id: str) -> str:
    """Execute a tool call and return the result as a JSON string."""
    log.info("tool call: %s(%s) tenant=%s", tool_name, tool_args, tenant_id)
    try:
        if tool_name == "check_stock":
            result = check_stock(tenant_id, tool_args["product_name"], tool_args["quantity"])
        elif tool_name == "search_products":
            result = search_products(tenant_id, tool_args["query"])
        elif tool_name == "list_products":
            result = list_products(tenant_id)
        elif tool_name == "reserve_stock":
            result = reserve_stock(tenant_id, tool_args["product_name"], tool_args["quantity"])
        else:
            result = {"error": f"Unknown tool: {tool_name}"}
    except (KeyError, TypeError) as e:
        # Guard against the model sending malformed / missing arguments.
        result = {"error": f"Argumentos inválidos para {tool_name}: {e}"}

    return json.dumps(result, ensure_ascii=False)
