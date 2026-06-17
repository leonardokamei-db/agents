"""Repositório de agentes — encapsula todo o SQL da tabela `agents`.

INVARIANTE DE TENANCY: a resolução do agente é por `(tenant_id, slug)` e as
listagens são sempre escopadas por tenant. A PK `id` é opaca e global.
"""

from app.db import read_connection, transaction
from app.domain import AgentConfig

# Campos editáveis via UPDATE (whitelist — evita update de colunas indevidas).
_EDITABLE = (
    "name", "system_prompt", "business_rules", "max_turns",
    "product_mode", "product_api_url", "product_api_key",
    "rag_enabled", "external_products",
)
_BOOL_FIELDS = ("rag_enabled", "external_products")


def _coerce(field: str, value):
    return int(bool(value)) if field in _BOOL_FIELDS else value


class AgentRepository:
    def get_by_id(self, agent_id: str) -> AgentConfig | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
            return AgentConfig.from_row(row) if row else None

    def get(self, tenant_id: str, slug: str) -> AgentConfig | None:
        """Resolve um agente pelo par (tenant, slug) — a chave usada nas rotas."""
        with read_connection() as conn:
            row = conn.execute(
                "SELECT * FROM agents WHERE tenant_id = ? AND slug = ?", (tenant_id, slug)
            ).fetchone()
            return AgentConfig.from_row(row) if row else None

    def list_for_tenant(self, tenant_id: str) -> list[AgentConfig]:
        with read_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at", (tenant_id,)
            ).fetchall()
            return [AgentConfig.from_row(r) for r in rows]

    def list_all(self) -> list[AgentConfig]:
        with read_connection() as conn:
            rows = conn.execute("SELECT * FROM agents ORDER BY created_at").fetchall()
            return [AgentConfig.from_row(r) for r in rows]

    def exists(self, tenant_id: str, slug: str) -> bool:
        with read_connection() as conn:
            return conn.execute(
                "SELECT 1 FROM agents WHERE tenant_id = ? AND slug = ?", (tenant_id, slug)
            ).fetchone() is not None

    def insert(self, agent_id: str, tenant_id: str, slug: str, data: dict) -> None:
        with transaction() as conn:
            conn.execute(
                "INSERT INTO agents (id, tenant_id, slug, name, system_prompt, "
                "business_rules, max_turns, product_mode, product_api_url, "
                "product_api_key, rag_enabled, external_products) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    agent_id, tenant_id, slug, data["name"],
                    data.get("system_prompt", ""), data.get("business_rules", ""),
                    data.get("max_turns", 15), data.get("product_mode", "none"),
                    data.get("product_api_url", ""), data.get("product_api_key", ""),
                    int(data.get("rag_enabled", True)), int(data.get("external_products", True)),
                ),
            )

    def update(self, agent_id: str, changes: dict) -> None:
        fields = {k: _coerce(k, v) for k, v in changes.items()
                  if k in _EDITABLE and v is not None}
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        with transaction() as conn:
            conn.execute(
                f"UPDATE agents SET {sets} WHERE id = ?",
                (*fields.values(), agent_id),
            )

    def delete(self, agent_id: str) -> bool:
        with transaction() as conn:
            return conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,)).rowcount > 0
