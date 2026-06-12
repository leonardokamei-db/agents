"""CRUD de agentes (tenants) na tabela `agents` do core.db.

Criar um agente aqui é o que "cria o endpoint": as rotas usam o id como path
param (/v1/agents/{agent_id}/...), então um agente novo passa a aceitar
requisições imediatamente, sem redeploy.
"""

import logging
import re
import secrets
import unicodedata

from app.db import connect, row_to_dict

log = logging.getLogger("blip-agent.tenants")

_AGENT_FIELDS = (
    "name", "system_prompt", "business_rules", "max_turns",
    "product_mode", "product_api_url", "product_api_key",
)


def slugify(name: str) -> str:
    decomposed = unicodedata.normalize("NFKD", name.lower())
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-") or "agente"


def create_agent(data: dict) -> dict:
    """Insere um agente novo e gera sua api_key. Retorna o registro completo."""
    agent_id = data.get("id") or slugify(data["name"])
    api_key = f"blip-{secrets.token_urlsafe(24)}"

    conn = connect()
    try:
        if conn.execute("SELECT 1 FROM agents WHERE id = ?", (agent_id,)).fetchone():
            raise ValueError(f"Já existe um agente com id '{agent_id}'.")
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
        conn.commit()
    finally:
        conn.close()
    log.info("Agente criado: %s", agent_id)
    return get_agent(agent_id)


def get_agent(agent_id: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


def list_agents() -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM agents ORDER BY created_at").fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def update_agent(agent_id: str, changes: dict) -> dict | None:
    """Atualiza apenas os campos editáveis presentes em `changes`."""
    fields = {k: v for k, v in changes.items() if k in _AGENT_FIELDS and v is not None}
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn = connect()
        try:
            conn.execute(
                f"UPDATE agents SET {sets} WHERE id = ?",
                (*fields.values(), agent_id),
            )
            conn.commit()
        finally:
            conn.close()
    return get_agent(agent_id)


def delete_agent(agent_id: str) -> bool:
    conn = connect()
    try:
        cur = conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
