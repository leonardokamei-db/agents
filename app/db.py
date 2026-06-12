"""Banco SQLite central (core.db): tabelas `agents` e `products`.

Somente stdlib `sqlite3` — sem ORM. As funções de acesso ficam em
app.tenants (agents) e app.catalog (products); aqui mora só a infraestrutura.
"""

import sqlite3

from app.config import CORE_DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    api_key         TEXT NOT NULL UNIQUE,
    system_prompt   TEXT NOT NULL DEFAULT '',
    business_rules  TEXT NOT NULL DEFAULT '',
    max_turns       INTEGER NOT NULL DEFAULT 15,
    product_mode    TEXT NOT NULL DEFAULT 'none',  -- none | internal | external
    product_api_url TEXT NOT NULL DEFAULT '',
    product_api_key TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    unit        TEXT NOT NULL DEFAULT 'unidade'
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(CORE_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    """Cria o schema se não existir (idempotente)."""
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}
