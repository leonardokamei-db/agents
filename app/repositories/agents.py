"""Repositório de agentes — encapsula todo o SQL da tabela `agents`."""

from app.db import read_connection, transaction
from app.domain import AgentConfig

# Campos editáveis via UPDATE (whitelist — evita update de colunas indevidas).
_EDITABLE = (
    "name", "system_prompt", "business_rules", "max_turns",
    "product_mode", "product_api_url", "product_api_key",
)


class AgentRepository:
    def get(self, agent_id: str) -> AgentConfig | None:
        with read_connection() as conn:
            row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
            return AgentConfig.from_row(row) if row else None

    def list(self) -> list[AgentConfig]:
        with read_connection() as conn:
            rows = conn.execute("SELECT * FROM agents ORDER BY created_at").fetchall()
            return [AgentConfig.from_row(r) for r in rows]

    def exists(self, agent_id: str) -> bool:
        with read_connection() as conn:
            return conn.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone() is not None

    def insert(self, agent_id: str, api_key: str, data: dict) -> None:
        with transaction() as conn:
            conn.execute(
                "INSERT INTO agents (id, name, api_key, system_prompt, business_rules, "
                "max_turns, product_mode, product_api_url, product_api_key) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    agent_id, data["name"], api_key,
                    data.get("system_prompt", ""), data.get("business_rules", ""),
                    data.get("max_turns", 15), data.get("product_mode", "none"),
                    data.get("product_api_url", ""), data.get("product_api_key", ""),
                ),
            )

    def update(self, agent_id: str, changes: dict) -> None:
        fields = {k: v for k, v in changes.items() if k in _EDITABLE and v is not None}
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
