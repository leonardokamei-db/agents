"""Schemas de ferramentas (function calling do Groq) + dispatcher.

As definições vão ao LLM com `tool_choice="auto"`; quando o modelo chama uma,
o OrderAgent despacha via `execute_tool`, que devolve uma string JSON enviada
de volta como mensagem `tool`. Tudo opera sobre app.catalog, que abstrai
catálogo interno (SQLite) vs. API externa do cliente.
"""

import json
import logging

from app import catalog

log = logging.getLogger("blip-agent.tools")

PRODUCT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_stock",
            "description": "Verifica estoque e preço total de um produto para uma quantidade.",
            "parameters": {
                "type": "object",
                "properties": {
                    "product_name": {"type": "string", "description": "Nome do produto"},
                    "quantity": {"type": "integer", "description": "Quantidade desejada"},
                },
                "required": ["product_name", "quantity"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_products",
            "description": "Busca produtos por nome ou descrição quando o nome exato é incerto.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Termo de busca"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_products",
            "description": "Lista todos os produtos do catálogo com preço e estoque.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reserve_stock",
            "description": "Reserva estoque de um pedido. Use APENAS após confirmação explícita de compra.",
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


def execute_tool(tool_name: str, tool_args: dict, agent: dict) -> str:
    """Executa uma tool call e retorna o resultado como string JSON."""
    log.info("tool: %s(%s) agent=%s", tool_name, tool_args, agent["id"])
    try:
        if tool_name == "check_stock":
            result = catalog.check_stock(agent, tool_args["product_name"], tool_args["quantity"])
        elif tool_name == "search_products":
            result = catalog.search_products(agent, tool_args["query"])
        elif tool_name == "list_products":
            result = catalog.list_products(agent)
        elif tool_name == "reserve_stock":
            result = catalog.reserve_stock(agent, tool_args["product_name"], tool_args["quantity"])
        else:
            result = {"error": f"Ferramenta desconhecida: {tool_name}"}
    except (KeyError, TypeError) as e:
        # O modelo pode mandar argumentos malformados/faltando.
        result = {"error": f"Argumentos inválidos para {tool_name}: {e}"}

    return json.dumps(result, ensure_ascii=False)
