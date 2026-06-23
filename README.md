# blip-agent

Plataforma **multi-tenant** de agentes de atendimento. Um **tenant** (cliente) é
dono de N **agentes**; cada agente tem endpoint de chat próprio, base de
conhecimento (RAG) própria, regras de negócio editáveis e catálogo de produtos
opcional — tudo configurável por API/painel, **sem redeploy**.

- **Stack:** FastAPI (Python 3.12) · Groq (LLM) · Jina (embeddings) · SQLite + sqlite-vec · Celery+Redis (opcional, fila de ingestão)
- **Deploy:** Railway (NIXPACKS), `uvicorn server:app` (`server.py` só reexporta `app.main:app`)
- **Painel:** `client.html` servido em `/` (usa a `ADMIN_API_KEY` como superusuário)

> **Documentação de referência:** [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) (visão
> completa — é a fonte de verdade) · [`docs/DEBUG.md`](docs/DEBUG.md) (operação/logs/fila) ·
> [`docs/SKILLS_REMOTAS.md`](docs/SKILLS_REMOTAS.md) (cada skill como função Lambda) ·
> [`docs/REVISAO_ARQUITETURA.md`](docs/REVISAO_ARQUITETURA.md) (histórico de decisões).

## O agente flexível + skills

Não há mais um agente por intenção nem classificador de palavra-chave. Existe **um**
agente de conversa — o `SkilledAgent` — que recebe um **conjunto de skills** e deixa
o **LLM decidir qual chamar** (function calling). Cada **skill** é uma capacidade
discreta com contrato único (`nome + descrição + args Pydantic + handler →
SkillResult`), registrada em `app/skills/`.

O cliente **escolhe quais tools acoplar** a cada agente (campo `skills`; vazio =
derivado das feature flags). Skills atuais:

| Skill | O que faz |
|---|---|
| `knowledge_search` | Busca na base de conhecimento (RAG) |
| `check_stock` / `search_products` / `list_products` | Consulta catálogo, estoque e preço |
| `reserve_stock` | Reserva (só catálogo interno) → handoff p/ pagamento |
| `check_catalog` | Diagnostica a integração de catálogo (interno/externo) |
| `escalate_to_human` | Handoff para atendente humano (terminal, 0 token) |

> **Próximo passo (desenho aprovado):** cada skill pode virar uma **função
> independente, estilo AWS Lambda** (`RemoteSkill`), deployável sozinha sem afetar as
> outras nem a API — inclui a nova tool `send_email`. O caminho é só **transporte**:
> schema, seleção e prompt não mudam. Desenho completo, decisão por decisão, em
> [`docs/SKILLS_REMOTAS.md`](docs/SKILLS_REMOTAS.md).

## Arquitetura (camadas, dependência só "para baixo")

```
routers/      → HTTP: validação Pydantic, RBAC, status (sem regra de negócio, sem SQL)
services/     → regra de negócio (levanta AppError tipado)
repositories/ → TODO o SQL; multi-tenant (WHERE agent_id / tenant_id)
domain.py     → tipos (AgentConfig, ProductRow, AgentResult, Principal, ...)
```

```
server.py         — entrypoint (reexporta app.main:app)
client.html       — painel admin + chat de teste
app/
  main.py         — FastAPI: monta routers, lifespan, handlers, /health, /
  config.py       — env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, modelos, paths)
  domain.py       — tipos de domínio
  db.py           — SQLite core.db + migrações idempotentes no boot
  errors.py / messages.py — AppError tipado / copy pt-BR centralizada
  llm.py / embeddings.py  — clientes Groq / Jina (bloqueantes → asyncio.to_thread)
  rag.py          — vector store sqlite-vec (ingestão + busca)
  catalog.py      — produtos: SQLite interno OU API REST externa do cliente
  prompts.py      — system prompts compactos (só as regras das skills habilitadas)
  orchestrator.py — trunca histórico, aplica limite de turnos, delega ao agente
  agents/         — SkilledAgent (flexível, dirigido por skills) + FallbackAgent (estático)
  skills/         — knowledge · catalog · support (registry + decorator @skill)
  routers/        — tenants · agent · knowledge · products
  services/  repositories/  schemas/  — negócio · SQL · Pydantic, um módulo por domínio
  logging_ctx.py  — correlação de log (request_id + tenant via contextvars)
  tasks.py        — ingestão via Celery+Redis (opcional; fallback síncrono sem broker)
```

## API

Endpoints de agente ficam sob `/v1/tenants/{tid}/agents/{slug}/...`. RBAC
(`app/routers/deps.py`): `X-Admin-Key` = admin de plataforma; `X-API-Key` = owner do
tenant **ou** usuário membro (papel vem da membership).

### Plataforma (`X-Admin-Key`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/tenants` | Cria tenant → `api_key` + owner (exibidos só aqui) |
| GET | `/v1/tenants` | Lista tenants (sem segredos) |
| DELETE | `/v1/tenants/{tid}` | Exclui tenant (cascade + RAG) |

### Tenant e membros (`X-API-Key`)
| Método | Rota | Papel |
|---|---|---|
| GET | `/v1/tenants/{tid}` | member |
| GET / POST | `/v1/tenants/{tid}/members` | owner |
| DELETE | `/v1/tenants/{tid}/members/{user_id}` | owner (não remove o último owner) |

### Agentes (`X-API-Key`)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/tenants/{tid}/agents` | Cria agente → **abre o endpoint** de chat |
| GET | `/v1/tenants/{tid}/agents[/{slug}]` | Lista / configuração pública (sem segredos) |
| PUT | `/v1/tenants/{tid}/agents/{slug}/config` | Edita prompt, regras, turnos, flags e **skills** |
| DELETE | `/v1/tenants/{tid}/agents/{slug}` | Exclui agente (+ produtos por cascade + RAG) |
| POST | `/v1/tenants/{tid}/agents/{slug}/chat` | Conversa: `{message, history}` |
| * | `/v1/tenants/{tid}/agents/{slug}/knowledge/...` | Sobe/gere FAQ (RAG); **202** se enfileirado |
| * | `/v1/tenants/{tid}/agents/{slug}/products[/{id}]` | GET sempre; CRUD só no modo interno |

### Operacional
| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | status, modelo, celery on/off, tenants |
| GET | `/` | serve o `client.html` |

### Produtos via API externa
Com `product_mode = "external"`, o backend faz `GET {product_api_url}` (header
`Authorization: Bearer {product_api_key}`, se configurada) e espera `[{...}]` ou
`{"products": [...]}`. Busca e checagem de estoque rodam no backend; **reserva** em
catálogo externo gera handoff (a fonte da verdade é o cliente).

## Economia de tokens
- Só as últimas `HISTORY_LIMIT` mensagens (padrão **5**) vão ao Groq.
- System prompts compactos: base + **só** as regras das skills habilitadas.
- `RAG_TOP_K` chunks por pergunta (padrão **3**).
- Atalhos de **0 token**: match RAG fortíssimo responde o chunk literal; palavra-chave
  de escalonamento faz handoff determinístico (sem chamar o LLM).

## Rodando localmente
```bash
python -m venv .venv
.venv/Scripts/activate          # Windows
pip install -r requirements.txt
cp .env.example .env             # preencha GROQ_API_KEY, JINA_API_KEY, ADMIN_API_KEY
uvicorn server:app --reload --port 8000
```
Acesse http://localhost:8000 e informe a `ADMIN_API_KEY` (padrão dev:
`admin-dev-key`). No primeiro boot são criados o tenant `default` e o agente `demo`
(desligue com `SEED_DEMO=0`).

## Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `GROQ_API_KEY` | Sim | LLM (Groq). |
| `JINA_API_KEY` | Sim (RAG) | Embeddings (Jina). |
| `ADMIN_API_KEY` | Em produção | Admin de plataforma (padrão dev: `admin-dev-key`). |
| `GROQ_MODEL` | Não | Modelo do Groq (padrão `llama-3.3-70b-versatile`). |
| `JINA_MODEL` | Não | Modelo de embeddings (padrão `jina-embeddings-v3`). |
| `HISTORY_LIMIT` | Não | Mensagens de histórico enviadas ao LLM (padrão 5). |
| `RAG_TOP_K` | Não | Chunks RAG por pergunta (padrão 3). |
| `SEED_DEMO` | Não | `0` desativa o tenant/agente demo no primeiro boot. |
| `DB_DIR` | Não | Diretório dos SQLite (`core.db`, `rag.db`). No Railway: `/app/data`. |
| `DEFAULT_TENANT_ID` | Não | Tenant que recebe agentes legados na migração (padrão `default`). |
| `LOG_LEVEL` | Não | Nível de log (padrão `INFO`). |
| `REDIS_URL` | Não | Broker da fila de ingestão (Celery). Sem ele, a ingestão é síncrona. |
| `PORT` | Não | Definida automaticamente pelo Railway. |

> Sem `JINA_API_KEY` o servidor sobe, mas o RAG degrada: a busca retorna vazio e a
> ingestão responde 503 com mensagem clara.

### Persistência no Railway (Volume)
1. No serviço: **Settings → Volumes → New Volume**, mount path `/app/data`.
2. Em **Variables**, defina `DB_DIR = /app/data`.

Sem isso os bancos (`core.db`, `rag.db`) são recriados a cada deploy (agentes,
produtos e PDFs se perdem).
