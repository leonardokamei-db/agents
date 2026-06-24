# blip-agent

Plataforma **multi-tenant** de agentes de atendimento. Um **tenant** (cliente) é
dono de N **agentes**; cada agente tem endpoint de chat próprio, base de
conhecimento (RAG) própria, regras de negócio editáveis e catálogo de produtos
opcional — tudo configurável por API/painel, **sem redeploy**.

- **Stack:** Next.js 15 (App Router) · TypeScript · Groq (LLM) · Jina (embeddings) · **Postgres + pgvector** (dados + vetores) · Drizzle ORM
- **Deploy:** Railway (NIXPACKS) — `next build` / `next start`; estado no Postgres (sem SQLite, sem Redis)
- **Painel:** servido em `/` (mesma origem da API; usa a `ADMIN_API_KEY` como superusuário)

> Migrado de FastAPI/Python (SQLite + sqlite-vec + Celery/Redis) para Next.js/TS
> (Postgres + pgvector, ingestão síncrona). As **URLs e contratos da API foram
> preservados** (`/v1/...`, `/health`).

> **Documentação:** [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) (fonte de verdade) ·
> [`docs/DEBUG.md`](docs/DEBUG.md) (operação/logs) ·
> [`docs/SKILLS_REMOTAS.md`](docs/SKILLS_REMOTAS.md) (cada skill como Lambda).

## O agente flexível + skills

Existe **um** agente de conversa — o `SkilledAgent` — que recebe um **conjunto de
skills** e deixa o **LLM decidir qual chamar** (function calling). Cada **skill** é
uma capacidade discreta com contrato único (`nome + descrição + args Zod + handler →
SkillResult`), registrada em `src/server/skills/`.

| Skill | O que faz |
|---|---|
| `knowledge_search` | Busca na base de conhecimento (RAG) |
| `check_stock` / `search_products` / `list_products` | Consulta catálogo, estoque e preço |
| `reserve_stock` | Reserva (só catálogo interno) → handoff p/ pagamento |
| `check_catalog` | Diagnostica a integração de catálogo (interno/externo) |
| `escalate_to_human` | Handoff para atendente humano (terminal, 0 token) |

## Arquitetura (camadas, dependência só "para baixo")

```
src/app/v1/**/route.ts  → HTTP: validação Zod, RBAC, status (sem regra de negócio, sem SQL)
src/server/services/    → regra de negócio (levanta AppError tipado)
src/server/repositories/→ TODO o acesso a dados (Drizzle); multi-tenant (where agentId/tenantId)
src/server/domain.ts    → tipos (AgentConfig, ProductRow, AgentResult, Principal, ...)
```

```
src/
  app/                  — Next App Router: painel (page.tsx) + rotas (/v1/..., /health)
  server/
    config.ts           — env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, modelos)
    db/                 — schema.ts (Drizzle) · client.ts (postgres.js) · ddl.ts · bootstrap.ts
    domain.ts           — tipos de domínio  ·  schemas.ts — validação Zod
    errors.ts / messages.ts — AppError tipado / copy pt-BR centralizada
    logging.ts          — correlação de log (requestId + tenant via AsyncLocalStorage)
    llm.ts / embeddings.ts  — clientes Groq / Jina
    rag.ts              — vector store pgvector (chunking + ingestão + busca KNN)
    catalog.ts          — produtos: Postgres interno OU API REST externa do cliente
    prompts.ts          — system prompts compactos (só as regras das skills habilitadas)
    orchestrator.ts     — trunca histórico, aplica limite de turnos, delega ao agente
    agents/             — SkilledAgent (flexível) + FallbackAgent (estático)
    skills/             — knowledge · catalog · support (registry + registerLocal)
    http/               — auth.ts (RBAC) · route.ts (wrapper) · serialize.ts (wire snake_case)
scripts/                — setup-db.ts (extensão pgvector + DDL + seed) · seed.ts
```

## Rodando localmente

Pré-requisitos: **Node 20+** e um **Postgres com pgvector**.

```bash
# 1. Postgres com pgvector (Docker)
docker run -d --name blip-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# 2. Dependências e env
npm install
cp .env.example .env            # preencha DATABASE_URL, GROQ_API_KEY, JINA_API_KEY, ADMIN_API_KEY

# 3. Banco (extensão pgvector + tabelas + agente demo) e app
npm run db:setup
npm run dev                     # painel em http://localhost:3000
```

Acesse o painel e informe a `ADMIN_API_KEY` (padrão dev: `admin-dev-key`). No
`db:setup` são criados o tenant `default` e o agente `demo` (desligue com `SEED_DEMO=0`).

Scripts: `dev` · `build` · `start` · `typecheck` · `lint` · `db:setup` (extensão +
DDL + seed) · `db:seed` · `db:push` (sincroniza schema via drizzle-kit, p/ dev).

## API

URLs e contratos **idênticos** ao backend anterior. Endpoints de agente sob
`/v1/tenants/{tid}/agents/{slug}/...`. RBAC: `X-Admin-Key` = admin de plataforma;
`X-API-Key` = owner do tenant **ou** usuário membro (papel pela membership).

| Método | Rota | Descrição |
|---|---|---|
| POST/GET | `/v1/tenants` | Cria (admin) → api_key+owner / lista tenants |
| DELETE | `/v1/tenants/{tid}` | Exclui tenant (cascade + RAG) |
| GET | `/v1/tenants/{tid}` | Dados do tenant (member) |
| GET/POST | `/v1/tenants/{tid}/members` | Lista / convida (owner) |
| DELETE | `/v1/tenants/{tid}/members/{user_id}` | Remove membro (owner) |
| POST/GET | `/v1/tenants/{tid}/agents` | Cria (owner) → abre o endpoint / lista |
| GET/DELETE | `/v1/tenants/{tid}/agents/{slug}` | Config pública / exclui |
| PUT | `/v1/tenants/{tid}/agents/{slug}/config` | Edita prompt/regras/flags/skills (owner) |
| POST | `/v1/tenants/{tid}/agents/{slug}/chat` | Conversa: `{message, history}` |
| * | `.../knowledge/...` | Sobe/gere FAQ (RAG; ingestão síncrona → 200) |
| * | `.../products[/{id}]` | GET sempre; CRUD só no modo interno |
| GET | `/health` | status, modelo, tenants |

## Economia de tokens
- Só as últimas `HISTORY_LIMIT` mensagens (padrão **5**) vão ao Groq.
- System prompts compactos: base + **só** as regras das skills habilitadas.
- `RAG_TOP_K` chunks por pergunta (padrão **3**).
- Atalhos de **0 token**: match RAG fortíssimo responde o chunk literal; palavra-chave
  de escalonamento faz handoff determinístico (sem chamar o LLM).

## Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim | Postgres com pgvector (`postgresql://...`). |
| `GROQ_API_KEY` | Sim | LLM (Groq). |
| `JINA_API_KEY` | Sim (RAG) | Embeddings (Jina). |
| `ADMIN_API_KEY` | Em produção | Admin de plataforma (padrão dev: `admin-dev-key`). |
| `GROQ_MODEL` | Não | Padrão `llama-3.3-70b-versatile`. |
| `JINA_MODEL` | Não | Padrão `jina-embeddings-v3`. |
| `HISTORY_LIMIT` / `RAG_TOP_K` | Não | Padrão 5 / 3. |
| `SEED_DEMO` | Não | `0` desativa o agente demo no primeiro boot. |
| `DEFAULT_TENANT_ID` / `LOG_LEVEL` | Não | Padrão `default` / `INFO`. |

> Sem `JINA_API_KEY` o servidor sobe, mas o RAG degrada: a busca retorna vazio e a
> ingestão responde 503 com mensagem clara.

## Deploy (Railway + Supabase)

Banco no **Supabase** (Postgres + pgvector); app no **Railway**.

1. **Supabase:** crie o projeto, habilite a extensão `vector` e rode
   `supabase/schema.sql` no SQL Editor (cria as tabelas). Opcional: `supabase/seed.sql`.
2. **Conexão:** copie a string do **Pooler** do Supabase (host `*.pooler.supabase.com`,
   IPv4) — a conexão direta (`db.<ref>.supabase.co`) é IPv6 e o Railway não alcança.
3. **Railway:** defina `DATABASE_URL` (pooler), `GROQ_API_KEY`, `JINA_API_KEY`,
   `ADMIN_API_KEY` em Variables. O deploy roda `npm run db:seed` (semeia tenant
   default + demo, idempotente) e sobe o `next start` — ver `railway.toml`.
   Healthcheck em `/health`.

O cliente do banco já usa SSL e `prepare:false` (compatível com o pooler). Para um
Postgres self-managed com a extensão disponível, troque o start para `db:setup`
(a app cria o schema sozinha). Não há Volume nem SQLite: o estado vive no Postgres.
