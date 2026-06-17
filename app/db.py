"""Infraestrutura do banco SQLite central (core.db).

Aqui mora só a infra: schema, conexão, transação e a migração para o modelo
multi-tenant (ponto 19). O acesso a dados tipado vive em app/repositories/
(Tenant/User/Membership/Agent/Product) — nenhum SQL cru deve existir fora dali.

Modelo: um TENANT é dono de N AGENTES; USERS se vinculam a tenants via
MEMBERSHIPS com papel (owner/member). A credencial de consumo subiu para o
tenant — `agents` não tem mais `api_key`.
"""

import logging
import secrets
import sqlite3
from contextlib import contextmanager
from typing import Iterator

from app.config import CORE_DB_PATH, DEFAULT_TENANT_ID

log = logging.getLogger("blip-agent.db")


def _agents_ddl(table: str = "agents") -> str:
    """DDL da tabela de agentes (forma nova) — fonte única para o schema e para
    a reconstrução na migração, evitando divergência entre os dois."""
    return f"""
        CREATE TABLE IF NOT EXISTS {table} (
            id                 TEXT PRIMARY KEY,           -- PK opaca: {{tenant}}__{{slug}}
            tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            slug               TEXT NOT NULL,              -- único dentro do tenant
            name               TEXT NOT NULL,
            system_prompt      TEXT NOT NULL DEFAULT '',
            business_rules     TEXT NOT NULL DEFAULT '',
            max_turns          INTEGER NOT NULL DEFAULT 15,
            product_mode       TEXT NOT NULL DEFAULT 'none',   -- none | internal | external
            product_api_url    TEXT NOT NULL DEFAULT '',
            product_api_key    TEXT NOT NULL DEFAULT '',
            rag_enabled        INTEGER NOT NULL DEFAULT 1,     -- feature flag (ponto 8)
            external_products  INTEGER NOT NULL DEFAULT 1,     -- feature flag (ponto 8)
            created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (tenant_id, slug)
        );
    """


SCHEMA = f"""
CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    api_key     TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    api_key     TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',   -- owner | member
    PRIMARY KEY (tenant_id, user_id)
);

{_agents_ddl("agents")}

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

# Colunas copiadas do agents legado (sem api_key — a credencial sobe pro tenant).
_LEGACY_COPY_COLS = (
    "id, name, system_prompt, business_rules, max_turns, "
    "product_mode, product_api_url, product_api_key, created_at"
)


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


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _ensure_default_tenant(conn: sqlite3.Connection) -> str:
    """Cria o tenant `default` se faltar (idempotente). Loga a api_key uma vez."""
    row = conn.execute("SELECT api_key FROM tenants WHERE id = ?", (DEFAULT_TENANT_ID,)).fetchone()
    if row:
        return row["api_key"]
    api_key = f"blip-tenant-{secrets.token_urlsafe(24)}"
    conn.execute(
        "INSERT INTO tenants (id, name, api_key) VALUES (?, ?, ?)",
        (DEFAULT_TENANT_ID, "Default", api_key),
    )
    log.warning("Tenant %r criado. api_key=%s (guarde — usada para chat/consumo).",
                DEFAULT_TENANT_ID, api_key)
    return api_key


def ensure_default_tenant() -> str:
    """Garante o tenant `default` (usado no bootstrap de bancos novos)."""
    with transaction() as conn:
        return _ensure_default_tenant(conn)


def _migrate_agents_to_multitenant() -> None:
    """Migra um core.db legado (agents com api_key e sem tenant) para o modelo
    multi-tenant. Idempotente: só age quando `agents.tenant_id` não existe.

    Reconstrói `agents` na forma nova preservando os ids legados (slug=id) — os
    produtos e o RAG existentes continuam apontando para o mesmo agente, sem
    migração de dados entre bancos. Os agentes vão para o tenant `default`.

    Conexão dedicada em autocommit (isolation_level=None) para que
    `PRAGMA foreign_keys` faça efeito (no-op dentro de transação) e o BEGIN/COMMIT
    seja explícito — padrão seguro de table-rebuild do SQLite.
    """
    conn = sqlite3.connect(CORE_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # autocommit: controlamos transação/pragmas à mão
    try:
        cols = _columns(conn, "agents")
        if not cols or "tenant_id" in cols:
            return  # tabela ainda não existe (fresh) ou já migrada

        log.warning("Migrando core.db legado para o modelo multi-tenant...")
        _ensure_default_tenant(conn)
        had_api_key = "api_key" in cols

        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN")
        try:
            conn.execute(_agents_ddl("agents_new"))
            conn.execute(
                f"""
                INSERT INTO agents_new
                    (id, tenant_id, slug, name, system_prompt, business_rules,
                     max_turns, product_mode, product_api_url, product_api_key,
                     rag_enabled, external_products, created_at)
                SELECT id, ?, id, name, system_prompt, business_rules, max_turns,
                       product_mode, product_api_url, product_api_key, 1, 1, created_at
                FROM agents
                """,
                (DEFAULT_TENANT_ID,),
            )
            conn.execute("DROP TABLE agents")
            conn.execute("ALTER TABLE agents_new RENAME TO agents")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
        log.warning("Migração concluída: agentes -> tenant %r%s.", DEFAULT_TENANT_ID,
                    " (api_key por agente descartada)" if had_api_key else "")
    finally:
        conn.close()


def init_db() -> None:
    """Cria o schema se não existir e migra bancos legados (idempotente)."""
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
    _migrate_agents_to_multitenant()
