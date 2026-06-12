"""Camada de produtos com duas fontes possíveis por agente:

  * product_mode = "internal": tabela `products` do core.db, gerenciada pelos
    endpoints CRUD (/v1/agents/{id}/products).
  * product_mode = "external": API REST do próprio cliente. O backend faz
    GET {product_api_url} (header Authorization: Bearer {product_api_key},
    se configurada) e espera uma lista JSON de produtos:
        [{"id", "name", "description", "price", "stock", "unit"}, ...]
    (ou {"products": [...]}). Busca e checagem de estoque rodam em memória;
    reserva de estoque não é suportada externamente — o agente faz handoff.

Todas as funções recebem o registro do agente (dict de app.tenants) e são
síncronas — o OrderAgent roda em worker thread.
"""

import logging

import requests

from app.db import connect, row_to_dict
from app.textutil import word_set

log = logging.getLogger("blip-agent.catalog")

_EXTERNAL_TIMEOUT = 10  # segundos

# Palavras genéricas demais para ajudar a casar nome de produto.
_STOPWORDS = {"de", "do", "da", "para", "com", "os", "as", "um", "uma"}


# --------------------------------------------------------------------------- #
# API pública (usada pelas tools e pelos endpoints)
# --------------------------------------------------------------------------- #

def list_products(agent: dict) -> list[dict]:
    return _fetch_all(agent)


def search_products(agent: dict, query: str) -> list[dict]:
    """Busca por substring no nome/descrição (case/acento-insensível via word match)."""
    q = query.lower()
    return [
        p for p in _fetch_all(agent)
        if q in p["name"].lower() or q in (p.get("description") or "").lower()
    ] or _word_overlap_matches(_fetch_all(agent), query)


def check_stock(agent: dict, product_name: str, quantity: int) -> dict:
    product = _find_product(agent, product_name)
    if product is None:
        return {"product": product_name, "found": False,
                "error": "Produto não encontrado no catálogo."}
    available = int(product.get("stock") or 0)
    price = float(product.get("price") or 0)
    return {
        "product": product["name"],
        "found": True,
        "requested": quantity,
        "available": available,
        "can_fulfill": 0 < quantity <= available,
        "price_unit": round(price, 2),
        "price_total": round(price * quantity, 2),
        "unit": product.get("unit", "unidade"),
    }


def reserve_stock(agent: dict, product_name: str, quantity: int) -> dict:
    """Decrementa estoque (somente modo internal). Modo external não permite
    reserva — retorna erro orientando handoff."""
    if agent["product_mode"] != "internal":
        return {"success": False, "product": product_name,
                "error": "Reserva indisponível: catálogo externo. Encaminhe ao atendente."}

    product = _find_product(agent, product_name)
    if product is None:
        return {"success": False, "product": product_name, "error": "Produto não encontrado."}
    if quantity <= 0:
        return {"success": False, "product": product["name"], "error": "Quantidade inválida."}

    conn = connect()
    try:
        # Relê dentro da transação para não usar estoque desatualizado.
        row = conn.execute("SELECT * FROM products WHERE id = ?", (product["id"],)).fetchone()
        if row is None:
            return {"success": False, "product": product_name, "error": "Produto não encontrado."}
        if row["stock"] < quantity:
            return {"success": False, "product": row["name"],
                    "error": f"Estoque insuficiente (disponível: {row['stock']})."}
        new_stock = row["stock"] - quantity
        conn.execute("UPDATE products SET stock = ? WHERE id = ?", (new_stock, row["id"]))
        conn.commit()
    finally:
        conn.close()

    log.info("Reservado %d x %r (agent=%s) — novo estoque %d",
             quantity, row["name"], agent["id"], new_stock)
    return {"success": True, "product": row["name"], "new_stock": new_stock,
            "total_charged": round(row["price"] * quantity, 2)}


# --------------------------------------------------------------------------- #
# CRUD interno (endpoints de produtos)
# --------------------------------------------------------------------------- #

def create_product(agent_id: str, data: dict) -> dict:
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO products (agent_id, name, description, price, stock, unit) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (agent_id, data["name"], data.get("description", ""), data["price"],
             data.get("stock", 0), data.get("unit", "unidade")),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
        return row_to_dict(row)
    finally:
        conn.close()


def update_product(agent_id: str, product_id: int, changes: dict) -> dict | None:
    fields = {k: v for k, v in changes.items()
              if k in ("name", "description", "price", "stock", "unit") and v is not None}
    conn = connect()
    try:
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE products SET {sets} WHERE id = ? AND agent_id = ?",
                (*fields.values(), product_id, agent_id),
            )
            conn.commit()
        row = conn.execute(
            "SELECT * FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
        ).fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


def delete_product(agent_id: str, product_id: int) -> bool:
    conn = connect()
    try:
        cur = conn.execute(
            "DELETE FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Internos
# --------------------------------------------------------------------------- #

def _fetch_all(agent: dict) -> list[dict]:
    if agent["product_mode"] == "external":
        return _fetch_external(agent)
    if agent["product_mode"] == "internal":
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT * FROM products WHERE agent_id = ? ORDER BY name", (agent["id"],)
            ).fetchall()
            return [row_to_dict(r) for r in rows]
        finally:
            conn.close()
    return []  # product_mode == "none"


def _fetch_external(agent: dict) -> list[dict]:
    url = agent.get("product_api_url")
    if not url:
        return []
    headers = {}
    if agent.get("product_api_key"):
        headers["Authorization"] = f"Bearer {agent['product_api_key']}"
    try:
        resp = requests.get(url, headers=headers, timeout=_EXTERNAL_TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError) as e:
        log.warning("API externa de produtos falhou (agent=%s): %s", agent["id"], e)
        return []

    items = payload.get("products", payload) if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return []
    return [
        {
            "id": p.get("id", i),
            "name": str(p.get("name", "")),
            "description": str(p.get("description", "") or ""),
            "price": float(p.get("price", 0) or 0),
            "stock": int(p.get("stock", 0) or 0),
            "unit": str(p.get("unit", "unidade") or "unidade"),
        }
        for i, p in enumerate(items)
        if isinstance(p, dict) and p.get("name")
    ]


def _find_product(agent: dict, product_name: str) -> dict | None:
    """Resolve um produto pelo nome: exato -> substring -> sobreposição de palavras
    (cobre "fones de ouvido" -> "Fone Bluetooth", plurais, ordem trocada)."""
    products = _fetch_all(agent)
    target = product_name.lower()

    for p in products:
        if p["name"].lower() == target:
            return p
    substr = [p for p in products if target in p["name"].lower()]
    if substr:
        return min(substr, key=lambda p: len(p["name"]))
    matches = _word_overlap_matches(products, product_name)
    return matches[0] if matches else None


def _word_overlap_matches(products: list[dict], query: str) -> list[dict]:
    """Produtos ordenados por sobreposição de palavras com a query (prefixo conta,
    então "fones" casa com "fone"). Score zero fica de fora."""
    query_words = [w for w in word_set(query) if len(w) >= 3 and w not in _STOPWORDS]
    if not query_words:
        return []
    scored = []
    for p in products:
        hay_words = [w for w in word_set(f"{p['name']} {p.get('description', '')}")
                     if len(w) >= 3 and w not in _STOPWORDS]
        score = sum(1 for qw in query_words
                    if any(hw.startswith(qw) or qw.startswith(hw) for hw in hay_words))
        if score > 0:
            scored.append((score, p))
    scored.sort(key=lambda t: -t[0])
    return [p for _, p in scored]
