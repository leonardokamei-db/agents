/**
 * DDL canônico (idempotente) aplicado por `scripts/setup-db.ts` no boot/deploy.
 *
 * Substitui o `init_db()`/`init_rag_db()` do Python: cria a extensão pgvector e
 * todas as tabelas se faltarem. É a fonte de verdade da CRIAÇÃO de tabelas; o
 * `schema.ts` (Drizzle) é a fonte das QUERIES tipadas.
 *
 * INVARIANTE: este DDL e `schema.ts` descrevem as MESMAS colunas/tipos. Ao mudar
 * uma tabela, altere os dois (não há drizzle-kit no caminho de deploy). Greenfield:
 * sem migração de bancos legados.
 */

export const EXTENSION_SQL = `CREATE EXTENSION IF NOT EXISTS vector;`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    api_key     TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    api_key     TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS agents (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug               TEXT NOT NULL,
    name               TEXT NOT NULL,
    system_prompt      TEXT NOT NULL DEFAULT '',
    business_rules     TEXT NOT NULL DEFAULT '',
    max_turns          INTEGER NOT NULL DEFAULT 15,
    product_mode       TEXT NOT NULL DEFAULT 'none',
    product_api_url    TEXT NOT NULL DEFAULT '',
    product_api_key    TEXT NOT NULL DEFAULT '',
    rag_enabled        BOOLEAN NOT NULL DEFAULT true,
    external_products  BOOLEAN NOT NULL DEFAULT true,
    skills             JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agents_tenant_slug_uq UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    unit        TEXT NOT NULL DEFAULT 'unidade'
);

CREATE TABLE IF NOT EXISTS chunks (
    id           SERIAL PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    source_name  TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    content      TEXT NOT NULL,
    embedding    vector(384),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_agent_idx ON chunks (agent_id);
-- Busca vetorial exata (seq scan) basta no protótipo. Para escala, criar um índice
-- ANN depois, ex.: CREATE INDEX ON chunks USING hnsw (embedding vector_l2_ops);
`;
