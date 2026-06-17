"""Infraestrutura do banco SQLite central (core.db).

Aqui mora só a infra: schema, conexão e o helper de transação. O acesso a dados
tipado vive em app/repositories/ (AgentRepository, ProductRepository) — nenhum
SQL cru deve existir fora daquela camada.
"""

import sqlite3
from contextlib import contextmanager
from typing import Iterator

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
    conn.execute("PRAGMA journal_mode = WAL")  # melhor concorrência de leitura/escrita
    return conn


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Conexão com commit/rollback automáticos — elimina o connect()/try/finally
    repetido. Faz rollback em qualquer exceção e sempre fecha a conexão."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def read_connection() -> Iterator[sqlite3.Connection]:
    """Conexão somente-leitura (sem commit). Apenas garante o fechamento."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Cria o schema se não existir (idempotente)."""
    with transaction() as conn:
        conn.executescript(SCHEMA)
