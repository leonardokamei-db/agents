-- ============================================================================
-- blip-agent — schema (Supabase / Postgres + pgvector)
-- Rode UMA VEZ no SQL Editor do Supabase. Idempotente (CREATE ... IF NOT EXISTS).
-- Espelha src/server/db/ddl.ts (mantenha os dois em sincronia).
-- ============================================================================

-- Extensão pgvector. No Supabase você também pode habilitar em
-- Database -> Extensions -> "vector". Rodar aqui (como postgres) também funciona.
create extension if not exists vector;

create table if not exists tenants (
    id          text primary key,
    name        text not null,
    api_key     text not null unique,
    created_at  timestamptz not null default now()
);

create table if not exists users (
    id          text primary key,
    email       text not null unique,
    name        text not null default '',
    api_key     text not null unique,
    created_at  timestamptz not null default now()
);

create table if not exists memberships (
    tenant_id   text not null references tenants(id) on delete cascade,
    user_id     text not null references users(id) on delete cascade,
    role        text not null default 'member',
    primary key (tenant_id, user_id)
);

create table if not exists agents (
    id                 text primary key,
    tenant_id          text not null references tenants(id) on delete cascade,
    slug               text not null,
    name               text not null,
    system_prompt      text not null default '',
    business_rules     text not null default '',
    max_turns          integer not null default 15,
    product_mode       text not null default 'none',
    product_api_url    text not null default '',
    product_api_key    text not null default '',
    rag_enabled        boolean not null default true,
    external_products  boolean not null default true,
    skills             jsonb not null default '[]'::jsonb,
    created_at         timestamptz not null default now(),
    constraint agents_tenant_slug_uq unique (tenant_id, slug)
);

create table if not exists products (
    id          serial primary key,
    agent_id    text not null references agents(id) on delete cascade,
    name        text not null,
    description text not null default '',
    price       real not null,
    stock       integer not null default 0,
    unit        text not null default 'unidade'
);

create table if not exists tickets (
    id           serial primary key,
    agent_id     text not null references agents(id) on delete cascade,
    title        text not null,
    description  text not null default '',
    user_name    text not null,
    user_email   text not null,
    criticality  text not null default 'normal',
    created_at   timestamptz not null default now()
);

create index if not exists tickets_agent_idx on tickets (agent_id);

-- Telemetria de interações do chat (alimenta o dashboard do time de dados).
-- Sem PII: só metadados (intent, source, tokens, transbordo, tools...).
create table if not exists interactions (
    id              serial primary key,
    agent_id        text not null references agents(id) on delete cascade,
    tenant_id       text not null,
    intent          text not null default '',
    source          text not null default '',
    agent_used      text not null default '',
    tokens_used     integer not null default 0,
    should_handoff  boolean not null default false,
    handoff_reason  text not null default '',
    tools_called    jsonb not null default '[]'::jsonb,
    rag_chunks_used integer not null default 0,
    confidence      real not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists interactions_tenant_idx on interactions (tenant_id, created_at);
create index if not exists interactions_agent_idx on interactions (agent_id, created_at);

create table if not exists chunks (
    id           serial primary key,
    agent_id     text not null,
    source_name  text not null,
    chunk_index  integer not null,
    content      text not null,
    embedding    vector(384),
    created_at   timestamptz not null default now()
);

create index if not exists chunks_agent_idx on chunks (agent_id);
-- Busca vetorial exata (seq scan) basta no protótipo. Para escala, depois:
-- create index on chunks using hnsw (embedding vector_l2_ops);
