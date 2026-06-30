/**
 * DDL canônico (idempotente) aplicado por `scripts/setup-db.ts` no boot/deploy.
 *
 * Substitui o `init_db()`/`init_rag_db()` do Python: cria a extensão pgvector e
 * todas as tabelas se faltarem. É a fonte de verdade da CRIAÇÃO de tabelas; o
 * `schema.ts` (Drizzle) é a fonte das QUERIES tipadas.
 *
 * INVARIANTE: este DDL, `schema.ts` (Drizzle) e `supabase/schema.sql` (o artefato
 * rodado no SQL Editor do Supabase em produção) descrevem as MESMAS colunas/tipos.
 * Ao mudar uma tabela, altere os TRÊS — não há drizzle-kit no caminho de deploy, e o
 * deploy do Railway roda `db:seed` (não `db:setup`), então `SCHEMA_SQL` daqui NÃO é
 * aplicado em produção: quem cria as tabelas no Supabase é `supabase/schema.sql`.
 * Greenfield: sem migração de bancos legados.
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

CREATE TABLE IF NOT EXISTS tickets (
    id           SERIAL PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    user_name    TEXT NOT NULL,
    user_email   TEXT NOT NULL,
    criticality  TEXT NOT NULL DEFAULT 'normal',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tickets_agent_idx ON tickets (agent_id);

CREATE TABLE IF NOT EXISTS interactions (
    id              SERIAL PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    intent          TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    agent_used      TEXT NOT NULL DEFAULT '',
    tokens_used     INTEGER NOT NULL DEFAULT 0,
    should_handoff  BOOLEAN NOT NULL DEFAULT false,
    handoff_reason  TEXT NOT NULL DEFAULT '',
    tools_called    JSONB NOT NULL DEFAULT '[]'::jsonb,
    rag_chunks_used INTEGER NOT NULL DEFAULT 0,
    confidence      REAL NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard de dados: consultas por tenant e por agente, sempre numa janela de tempo.
CREATE INDEX IF NOT EXISTS interactions_tenant_idx ON interactions (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS interactions_agent_idx ON interactions (agent_id, created_at);

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
