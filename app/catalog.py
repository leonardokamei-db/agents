"""Camada de produtos com duas fontes possíveis por agente:

  * product_mode = "internal": tabela `products` (via ProductRepository).
  * product_mode = "external": API REST do próprio cliente. O backend faz
    GET {product_api_url} (header Authorization: Bearer {product_api_key},
    se configurada) e espera uma lista JSON de produtos
    ([{...}] ou {"products": [...]}). Reserva de estoque não é suportada
    externamente — o agente faz handoff.

Internamente trabalha com ProductRow (tipado); as funções públicas devolvem
dicts prontos para JSON (tools do LLM + respostas da API). Nenhum SQL aqui —
o acesso a dados fica no ProductRepository.
"""

import logging

import requests

from app.domain import AgentConfig, ProductRow
from app.messages import RESERVE_EXTERNAL_UNAVAILABLE
from app.repositories import ProductRepository
from app.textutil import word_set

log = logging.getLogger("blip-agent.catalog")

_EXTERNAL_TIMEOUT = 10  # segundos
_STOPWORDS = {"de", "do", "da", "para", "com", "os", "as", "um", "uma"}

_repo = ProductRepository()


# --------------------------------------------------------------------------- #
# API pública (usada pelas tools e pelos endpoints) — retorna dicts JSON-ready
# --------------------------------------------------------------------------- #

def list_products(agent: AgentConfig) -> list[dict]:
    return [p.to_dict() for p in _fetch_all(agent)]


def search_products(agent: AgentConfig, query: str) -> list[dict]:
    """Busca por substring no nome/descrição; cai para sobreposição de palavras."""
    q = query.lower()
    products = _fetch_all(agent)
    hits = [p for p in products if q in p.name.lower() or q in p.description.lower()]
    if not hits:
        hits = _word_overlap_matches(products, query)
    return [p.to_dict() for p in hits]


def check_stock(agent: AgentConfig, product_name: str, quantity: int) -> dict:
    product = _find_product(agent, product_name)
    if product is None:
        return {"product": product_name, "found": False,
                "error": "Produto não encontrado no catálogo."}
    return {
        "product": product.name,
        "found": True,
        "requested": quantity,
        "available": product.stock,
        "can_fulfill": 0 < quantity <= product.stock,
        "price_unit": round(product.price, 2),
        "price_total": round(product.price * quantity, 2),
        "unit": product.unit,
    }


def reserve_stock(agent: AgentConfig, product_name: str, quantity: int) -> dict:
    """Decrementa estoque (somente modo internal). Externo orienta handoff."""
    if agent.product_mode != "internal":
        return {"success": False, "product": product_name, "error": RESERVE_EXTERNAL_UNAVAILABLE}

    product = _find_product(agent, product_name)
    if product is None:
        return {"success": False, "product": product_name, "error": "Produto não encontrado."}
    if quantity <= 0:
        return {"success": False, "product": product.name, "error": "Quantidade inválida."}

    try:
        updated = _repo.decrement_stock(agent.id, product.id, quantity)
    except ValueError as e:
        return {"success": False, "product": product.name, "error": str(e)}

    log.info("Reservado %d x %r (agent=%s) — novo estoque %d",
             quantity, updated.name, agent.id, updated.stock)
    return {"success": True, "product": updated.name, "new_stock": updated.stock,
            "total_charged": round(product.price * quantity, 2)}


# --------------------------------------------------------------------------- #
# CRUD interno (endpoints de produtos) — delega ao repositório
# --------------------------------------------------------------------------- #

def create_product(agent_id: str, data: dict) -> dict:
    return _repo.create(agent_id, data).to_dict()


def update_product(agent_id: str, product_id: int, changes: dict) -> dict | None:
    product = _repo.update(agent_id, product_id, changes)
    return product.to_dict() if product else None


def delete_product(agent_id: str, product_id: int) -> bool:
    return _repo.delete(agent_id, product_id)


# --------------------------------------------------------------------------- #
# Internos — trabalham com ProductRow
# --------------------------------------------------------------------------- #

def _fetch_all(agent: AgentConfig) -> list[ProductRow]:
    if agent.product_mode == "external":
        return _fetch_external(agent)
    if agent.product_mode == "internal":
        return _repo.list_for_agent(agent.id)
    return []  # product_mode == "none"


def _fetch_external(agent: AgentConfig) -> list[ProductRow]:
    if not agent.product_api_url:
        return []
    headers = {}
    if agent.product_api_key:
        headers["Authorization"] = f"Bearer {agent.product_api_key}"
    try:
        resp = requests.get(agent.product_api_url, headers=headers, timeout=_EXTERNAL_TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError) as e:
        log.warning("API externa de produtos falhou (agent=%s): %s", agent.id, e)
        return []

    items = payload.get("products", payload) if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return []
    return [
        ProductRow.from_external(p, fallback_id=i)
        for i, p in enumerate(items)
        if isinstance(p, dict) and p.get("name")
    ]


def _find_product(agent: AgentConfig, product_name: str) -> ProductRow | None:
    """Resolve um produto pelo nome: exato -> substring -> sobreposição de palavras
    (cobre "fones de ouvido" -> "Fone Bluetooth", plurais, ordem trocada)."""
    products = _fetch_all(agent)
    target = product_name.lower()

    for p in products:
        if p.name.lower() == target:
            return p
    substr = [p for p in products if target in p.name.lower()]
    if substr:
        return min(substr, key=lambda p: len(p.name))
    matches = _word_overlap_matches(products, product_name)
    return matches[0] if matches else None


def _word_overlap_matches(products: list[ProductRow], query: str) -> list[ProductRow]:
    """Produtos ordenados por sobreposição de palavras com a query (prefixo conta,
    então "fones" casa com "fone"). Score zero fica de fora."""
    query_words = [w for w in word_set(query) if len(w) >= 3 and w not in _STOPWORDS]
    if not query_words:
        return []
    scored = []
    for p in products:
        hay_words = [w for w in word_set(f"{p.name} {p.description}")
                     if len(w) >= 3 and w not in _STOPWORDS]
        score = sum(1 for qw in query_words
                    if any(hw.startswith(qw) or qw.startswith(hw) for hw in hay_words))
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda t: -t[0])
    return [p for _, p in scored]
