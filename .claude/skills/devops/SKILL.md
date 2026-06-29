---
name: devops
description: >-
  Playbook de DevOps/operação do blip-agent (Next.js + TypeScript). Use para deploy
  (Railway/NIXPACKS), variáveis de ambiente, persistência (Postgres + pgvector),
  ingestão síncrona, observabilidade/logs, health check, setup/seed de banco e rodar
  a app local. Invoque ao mexer em Procfile, railway.toml, package.json, next.config.ts,
  drizzle.config.ts, .env, config.ts, db/*, scripts/* ou ao diagnosticar problemas de
  deploy ou banco.
---

# DevOps & Operação — blip-agent

App **Next.js 15 (App Router) + TypeScript** empacotada com **NIXPACKS** e rodada
no **Railway**. Dados e vetores num único **Postgres + pgvector**; LLM/embeddings
via APIs externas (Anthropic/Jina). Guia operacional detalhado: `docs/DEBUG.md`.

## Entrypoint e processo

- Build (railway.toml): `npm install --include=dev && npm run build` (o `--include=dev`
  garante typescript/eslint para o `next build`).
- Start (railway.toml e Procfile): `npm run db:setup && npm run start`.
  - `db:setup` (`scripts/setup-db.ts`, via **tsx**) cria a extensão pgvector + as
    tabelas (DDL idempotente) e semeia o tenant/agente demo. Seguro rodar a cada boot.
  - `start` = `next start`.
- Node fixado em `engines.node >= 20` no `package.json`.
- **`tsx` é dependência de runtime** (não devDependency): o `db:setup` o usa no deploy.

## Variáveis de ambiente (fonte: `src/server/config.ts`)

| Variável | Obrigatória | Default | Papel |
|---|---|---|---|
| `DATABASE_URL` | **Sim** | — | Postgres com pgvector (`postgresql://...`) |
| `ANTHROPIC_API_KEY` | Sim | — | LLM (Anthropic Claude) |
| `JINA_API_KEY` | Sim (RAG) | — | Embeddings (Jina) |
| `ADMIN_API_KEY` | **Em produção** | `admin-dev-key` | Admin de plataforma / superusuário |
| `ANTHROPIC_MODEL` / `JINA_MODEL` | Não | claude-haiku-4-5 / jina-embeddings-v3 | Modelos |
| `LLM_MAX_TOKENS` | Não | `512` | Teto de saída (sem `temperature`: Opus 4.7/4.8 rejeitam) |
| `HISTORY_LIMIT` / `RAG_TOP_K` | Não | `5` / `3` | Histórico ao LLM / chunks por pergunta |
| `SEED_DEMO` | Não | `1` | `0` desliga o agente demo no seed |
| `DEFAULT_TENANT_ID` / `LOG_LEVEL` | Não | `default` / `INFO` | Tenant padrão / log |

Em produção **defina `ADMIN_API_KEY`** e guarde a `api_key` do tenant `default`
(aparece **uma vez** no log do seed). **Não há mais** `REDIS_URL`, `DB_DIR`, nem
variáveis de SQLite.

## Persistência (Postgres, não mais SQLite)

Todo o estado vive no Postgres: tenants/users/memberships/agents/products e os
`chunks` com `embedding vector(384)`. No Railway:

1. Provisione um Postgres **com pgvector** — imagem `pgvector/pgvector:pg16` ou o
   plugin Postgres do Railway (≥ 16; o `db:setup` roda `CREATE EXTENSION vector`).
2. Exponha `DATABASE_URL` ao serviço da app.

Sem Volume, sem arquivos. O DDL canônico está em `src/server/db/ddl.ts` e **deve
ficar em sincronia** com o schema Drizzle (`src/server/db/schema.ts`) — não há
drizzle-kit no caminho de deploy (mude os dois ao alterar uma tabela).

## Setup / boot

Greenfield: sem migração de bancos legados. O deploy roda `db:setup`:
`CREATE EXTENSION vector` → DDL `CREATE TABLE IF NOT EXISTS ...` → `bootstrap()`
(tenant `default` + agente demo se `SEED_DEMO=1` e banco vazio). Tudo idempotente.
Evolução: `npm run db:push` (drizzle-kit, dev) ou adotar `generate`/`migrate`.

## Health check

```bash
curl -s localhost:3000/health
# {"status":"ok","model":"...","tenants":["default"]}
```

## Ingestão (sem fila)

A ingestão de PDF/texto roda **síncrona** no request (`200` com `chunks_created`).
Celery e Redis foram removidos. PDFs são extraídos com `unpdf` (puro JS) em
`src/server/rag.ts`. Ponto de extensão para fila assíncrona sem Redis (ex.: pg-boss):
`src/server/services/knowledge.ts`.

## Observabilidade

- Formato (`src/server/logging.ts`): `<iso>  INFO  [req=<id> tenant=<id>] blip-agent.<modulo>  <msg>`.
- `req` vem do header `X-Request-ID` (ou gerado pelo wrapper `http/route.ts`) e volta
  na resposta. `tenant` vem do path. Correlação via `AsyncLocalStorage`. Erros
  tratados não vazam detalhe ao usuário.

## Rodar local

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
npm install
cp .env.example .env          # DATABASE_URL, ANTHROPIC_API_KEY, JINA_API_KEY, ADMIN_API_KEY
npm run db:setup
npm run dev                   # painel em http://localhost:3000
```

Estático: `npm run typecheck` · `npm run lint` · `npm run build`.

## Checklist de deploy

- [ ] Postgres com pgvector; `DATABASE_URL` exposta ao serviço.
- [ ] `ANTHROPIC_API_KEY`, `JINA_API_KEY`, `ADMIN_API_KEY` definidas.
- [ ] Build = `npm install --include=dev && npm run build`; start roda `db:setup` antes.
- [ ] `/health` responde `ok` e lista os tenants esperados.
- [ ] `SEED_DEMO=0` se não quiser o agente demo.
- [ ] Sem `JINA_API_KEY`: a app sobe, mas RAG degrada (busca vazia; ingestão 503).
