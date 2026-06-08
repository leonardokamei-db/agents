"""In-app SQLite product database.

Uses only the standard-library `sqlite3` module — no ORM, no external deps.
The OrderAgent queries this through Groq tool use so prices and stock are always
real (never hallucinated).

The DB lives in a single file (products.db) next to this module. `seed_database()`
is idempotent: it creates the schema if missing and seeds the demo catalog only
when the table is empty.
"""

import logging
import sqlite3
from pathlib import Path

log = logging.getLogger("blip-agent.db")

DB_PATH = Path(__file__).parent / "products.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    unit TEXT DEFAULT 'unidade'
);
"""

# Demo catalog for "loja_demo" — a mix of in-stock, low-stock and out-of-stock
# products so the agent's edge cases can be exercised.
SEED_PRODUCTS = [
    # (name, description, price, stock, unit)
    ("Smartphone Galaxy A55", "Smartphone 5G, 256GB, tela AMOLED 6.6\"", 1899.90, 12, "unidade"),
    ("Notebook Ideapad 3", "Notebook 15.6\", Ryzen 5, 8GB RAM, SSD 512GB", 3299.00, 5, "unidade"),
    ("Fone Bluetooth JBL Tune", "Fone over-ear sem fio, bateria 40h", 299.90, 2, "unidade"),
    ("Smart TV 50\" 4K", "Smart TV LED 50 polegadas, 4K, Wi-Fi", 2499.00, 0, "unidade"),
    ("Mouse Gamer RGB", "Mouse óptico 7200 DPI com iluminação RGB", 149.90, 30, "unidade"),
    ("Teclado Mecânico ABNT2", "Teclado mecânico switch blue, layout ABNT2", 389.00, 1, "unidade"),
    ("Carregador Turbo USB-C", "Carregador rápido 65W USB-C", 119.90, 0, "unidade"),
    ("Webcam Full HD 1080p", "Webcam 1080p com microfone embutido", 219.90, 8, "unidade"),
]


def get_db_connection() -> sqlite3.Connection:
    """Return a connection with row access by column name."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def seed_database() -> None:
    """Create the schema and seed the demo catalog once (idempotent)."""
    conn = get_db_connection()
    try:
        conn.executescript(SCHEMA)
        existing = conn.execute(
            "SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?", ("loja_demo",)
        ).fetchone()["n"]
        if existing == 0:
            conn.executemany(
                "INSERT INTO products (tenant_id, name, description, price, stock, unit) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [("loja_demo", *p) for p in SEED_PRODUCTS],
            )
            conn.commit()
            log.info("Seeded %d products for loja_demo.", len(SEED_PRODUCTS))
        else:
            log.info("Database already seeded (%d products for loja_demo).", existing)
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# Words too generic to help match a product name.
_MATCH_STOPWORDS = {"de", "do", "da", "para", "com", "e", "o", "a", "um", "uma", "os", "as"}


def _significant_words(text: str) -> list[str]:
    """Lowercased query words worth matching on (>=3 chars, not stopwords)."""
    words = "".join(c if c.isalnum() else " " for c in text.lower()).split()
    return [w for w in words if len(w) >= 3 and w not in _MATCH_STOPWORDS]


def get_product(tenant_id: str, product_name: str) -> dict | None:
    """Find a single product by name within a tenant.

    Resolution order:
      1. Exact (case-insensitive) name match.
      2. Substring LIKE match on the full query.
      3. Word-overlap: the product whose name/description shares the most query
         words (handles "fones de ouvido" -> "Fone Bluetooth JBL Tune", plurals,
         word order). Returns None only if nothing overlaps at all.
    """
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT * FROM products WHERE tenant_id = ? AND LOWER(name) = LOWER(?)",
            (tenant_id, product_name),
        ).fetchone()
        if row is not None:
            return _row_to_dict(row)

        row = conn.execute(
            "SELECT * FROM products WHERE tenant_id = ? AND LOWER(name) LIKE LOWER(?) "
            "ORDER BY LENGTH(name) ASC LIMIT 1",
            (tenant_id, f"%{product_name}%"),
        ).fetchone()
        if row is not None:
            return _row_to_dict(row)

        # Word-overlap fallback.
        query_words = _significant_words(product_name)
        if not query_words:
            return None
        rows = conn.execute(
            "SELECT * FROM products WHERE tenant_id = ?", (tenant_id,)
        ).fetchall()
        best, best_score = None, 0
        for r in rows:
            haystack = f"{r['name']} {r['description'] or ''}".lower()
            # Count query words that appear as a prefix of some product word
            # (so "fones" matches "fone").
            score = sum(
                1 for qw in query_words
                if any(hw.startswith(qw) or qw.startswith(hw)
                       for hw in _significant_words(haystack))
            )
            if score > best_score:
                best, best_score = r, score
        return _row_to_dict(best) if best else None
    finally:
        conn.close()


def search_products(tenant_id: str, query: str) -> list[dict]:
    """Search by name OR description (case-insensitive substring)."""
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM products WHERE tenant_id = ? "
            "AND (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?)) "
            "ORDER BY name ASC",
            (tenant_id, f"%{query}%", f"%{query}%"),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def list_products(tenant_id: str) -> list[dict]:
    """List every product for a tenant with current stock and price."""
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM products WHERE tenant_id = ? ORDER BY name ASC",
            (tenant_id,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


def check_stock(tenant_id: str, product_name: str, quantity: int) -> dict:
    """Check availability and compute the total price for a requested quantity."""
    product = get_product(tenant_id, product_name)
    if product is None:
        return {
            "product": product_name,
            "found": False,
            "error": "Produto não encontrado no catálogo.",
        }

    available = product["stock"]
    price_unit = product["price"]
    can_fulfill = quantity > 0 and available >= quantity
    return {
        "product": product["name"],
        "found": True,
        "requested": quantity,
        "available": available,
        "can_fulfill": can_fulfill,
        "price_unit": round(price_unit, 2),
        "price_total": round(price_unit * quantity, 2),
        "unit": product["unit"],
    }


def reserve_stock(tenant_id: str, product_name: str, quantity: int) -> dict:
    """Decrement stock atomically. Refuses if insufficient stock or unknown product."""
    # Resolve the product using the same matching as check_stock so the model
    # can confirm a purchase using whatever phrasing it used before.
    product = get_product(tenant_id, product_name)
    if product is None:
        return {"success": False, "product": product_name,
                "error": "Produto não encontrado."}
    if quantity <= 0:
        return {"success": False, "product": product["name"],
                "error": "Quantidade inválida."}

    conn = get_db_connection()
    try:
        # Re-read inside the transaction to avoid a stale stock value.
        row = conn.execute(
            "SELECT * FROM products WHERE id = ?", (product["id"],)
        ).fetchone()
        if row is None:
            return {"success": False, "product": product_name,
                    "error": "Produto não encontrado."}
        if row["stock"] < quantity:
            return {"success": False, "product": row["name"],
                    "error": f"Estoque insuficiente (disponível: {row['stock']})."}

        new_stock = row["stock"] - quantity
        conn.execute(
            "UPDATE products SET stock = ? WHERE id = ?", (new_stock, row["id"])
        )
        conn.commit()
        log.info("Reserved %d x %r (tenant=%s) — new stock %d",
                 quantity, row["name"], tenant_id, new_stock)
        return {
            "success": True,
            "product": row["name"],
            "new_stock": new_stock,
            "total_charged": round(row["price"] * quantity, 2),
        }
    finally:
        conn.close()
