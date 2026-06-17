"""Repositório de produtos (catálogo interno) — todo o SQL da tabela `products`.

INVARIANTE DE TENANCY: todo método recebe `agent_id` e SEMPRE aplica
`WHERE agent_id = ?`. Isso transforma o isolamento entre tenants (antes
dependente de disciplina manual em cada query) numa garantia da classe.
"""

from app.db import read_connection, transaction
from app.domain import ProductRow

_EDITABLE = ("name", "description", "price", "stock", "unit")


class ProductRepository:
    def list_for_agent(self, agent_id: str) -> list[ProductRow]:
        with read_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM products WHERE agent_id = ? ORDER BY name", (agent_id,)
            ).fetchall()
            return [ProductRow.from_db_row(r) for r in rows]

    def get(self, agent_id: str, product_id: int) -> ProductRow | None:
        with read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
            ).fetchone()
            return ProductRow.from_db_row(row) if row else None

    def create(self, agent_id: str, data: dict) -> ProductRow:
        with transaction() as conn:
            cur = conn.execute(
                "INSERT INTO products (agent_id, name, description, price, stock, unit) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (agent_id, data["name"], data.get("description", ""), data["price"],
                 data.get("stock", 0), data.get("unit", "unidade")),
            )
            row = conn.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
            return ProductRow.from_db_row(row)

    def update(self, agent_id: str, product_id: int, changes: dict) -> ProductRow | None:
        fields = {k: v for k, v in changes.items() if k in _EDITABLE and v is not None}
        with transaction() as conn:
            if fields:
                sets = ", ".join(f"{k} = ?" for k in fields)
                conn.execute(
                    f"UPDATE products SET {sets} WHERE id = ? AND agent_id = ?",
                    (*fields.values(), product_id, agent_id),
                )
            row = conn.execute(
                "SELECT * FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
            ).fetchone()
            return ProductRow.from_db_row(row) if row else None

    def delete(self, agent_id: str, product_id: int) -> bool:
        with transaction() as conn:
            cur = conn.execute(
                "DELETE FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
            )
            return cur.rowcount > 0

    def decrement_stock(self, agent_id: str, product_id: int, quantity: int) -> ProductRow:
        """Decrementa o estoque atomicamente, relendo dentro da transação.

        Levanta ValueError se o produto sumiu ou se o estoque é insuficiente —
        o chamador (service) traduz para a resposta apropriada.
        """
        with transaction() as conn:
            row = conn.execute(
                "SELECT * FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
            ).fetchone()
            if row is None:
                raise ValueError("Produto não encontrado.")
            if row["stock"] < quantity:
                raise ValueError(f"Estoque insuficiente (disponível: {row['stock']}).")
            conn.execute(
                "UPDATE products SET stock = stock - ? WHERE id = ? AND agent_id = ?",
                (quantity, product_id, agent_id),
            )
            new_row = conn.execute(
                "SELECT * FROM products WHERE id = ? AND agent_id = ?", (product_id, agent_id)
            ).fetchone()
            return ProductRow.from_db_row(new_row)
