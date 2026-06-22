---
name: devops
description: >-
  Playbook de DevOps/operação do blip-agent. Use para deploy (Railway/NIXPACKS),
  variáveis de ambiente, persistência de dados (DB_DIR/Volume), workers
  Celery+Redis, observabilidade/logs, health check, migrações de boot e rodar a
  app local. Invoque ao mexer em Procfile, railway.toml, runtime.txt,
  requirements.txt, .env, config.py, tasks.py, logging_ctx.py ou ao diagnosticar
  problemas de deploy, persistência ou fila.
---

# DevOps & Operação — blip-agent

App FastAPI single-process empacotada com **NIXPACKS** e rodada no **Railway**.
Bancos em **SQLite** (arquivos), embeddings e LLM via **APIs externas** (Jina/Groq).
Guia operacional detalhado: `docs/DEBUG.md`.

## Entrypoint e processo

- Comando de start (Procfile **e** railway.toml): `uvicorn server:app --host 0.0.0.0 --port $PORT`.
- `server.py` só **reexporta** `app.main:app` — a app real vive em `app/main.py`.
  Use `server:app` em deploy; `app.main:app` funciona localmente também.
- Python fixado em `runtime.txt` (`python-3.12.8`).
- `requirements.txt` é enxuto **de propósito** (sem torch/sentence-transformers —
  embeddings são hospedados na Jina). Não reintroduza dependências pesadas.

## Variáveis de ambiente (fonte: `app/config.py`)

| Variável | Obrigatória | Default | Papel |
|---|---|---|---|
| `GROQ_API_KEY` | Sim | — | LLM (Groq) |
| `JINA_API_KEY` | Sim (RAG) | — | Embeddings (Jina) |
| `ADMIN_API_KEY` | **Em produção** | `admin-dev-key` | Admin de plataforma / superusuário |
| `DB_DIR` | **Em produção** | raiz do repo | Diretório de `core.db`/`rag.db` → aponte para o Volume |
| `GROQ_MODEL` | Não | `llama-3.3-70b-versatile` | Modelo do Groq |
| `JINA_MODEL` | Não | `jina-embeddings-v3` | Modelo de embeddings |
| `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` | Não | `512` / `0.7` | Geração |
| `HISTORY_LIMIT` | Não | `5` | Mensagens enviadas ao LLM |
| `RAG_TOP_K` | Não | `3` | Chunks por pergunta |
| `SEED_DEMO` | Não | `1` | `0` desliga o agente demo no 1º boot |
| `DEFAULT_TENANT_ID` | Não | `default` | Tenant dos agentes migrados |
| `LOG_LEVEL` | Não | `INFO` | Nível de log |
| `REDIS_URL` | Não | vazio | Liga a fila Celery (vazio = síncrono) |
| `PORT` | Não | injetado pelo Railway | Porta do uvicorn |

Em produção **defina `ADMIN_API_KEY`** (o default `admin-dev-key` é só para dev) e
guarde a `api_key` do tenant `default` que aparece **uma vez** no log do 1º boot.
Nunca commite `.env` (use `.env.example` como referência).

## Persistência (a pegadinha nº 1)

Os SQLite vivem em `DB_DIR`. **Sem volume, todo deploy recria os bancos** — agentes,
produtos e PDFs somem. No Railway:

1. Settings → Volumes → New Volume, mount path **`/app/data`**.
2. Variables → `DB_DIR = /app/data`.

`core.db` = tenants/users/memberships/agents/products. `rag.db` = chunks +
embeddings (sqlite-vec). Conexão usa **WAL** (`PRAGMA journal_mode = WAL`) para
concorrência de leitura/escrita; ainda assim é arquivo único — escrita concorrente
pesada é o limite (caminho de evolução: Postgres).

> Comentário **desatualizado** em `railway.toml`: fala em baixar "modelo de
> embedding (~80MB) + torch" e cita "products.db". Não é mais verdade (Jina
> hospedada; arquivos são `core.db`/`rag.db`). Ajuste se for tocar no arquivo.

## Migrações de boot (automáticas, idempotentes)

`lifespan` em `main.py` chama `init_db()` + `init_rag_db()` + `_bootstrap()`:
- cria o schema se faltar;
- migra `core.db` legado (agente com `api_key`, sem tenant) para multi-tenant
  (agentes → tenant `default`, `api_key` por agente descartada, produtos/RAG
  preservados);
- renomeia `chunks.tenant_id` → `agent_id` em `rag.db`;
- garante o tenant `default` e semeia o agente `demo` (se `SEED_DEMO=1` e banco vazio).

Rodar de novo é seguro (idempotente). Não há ferramenta de migração externa —
o boot é o migrador.

## Health check

`GET /health` (é o `healthcheckPath` do Railway, timeout 300s):

```bash
curl -s localhost:8000/health
# {"status":"ok","model":"...","celery":false,"tenants":["default"]}
```

`celery` reflete `CELERY_ENABLED` (há `REDIS_URL`?). `tenants` lista os ids — útil
para confirmar que o Volume persistiu os dados após um deploy.

## Workers / fila de ingestão (Celery + Redis)

Por padrão **não há broker** → ingestão de PDF/texto roda **síncrona** no processo
web (responde 200 com `chunks_created`). Para descarregar (deploy fora do Railway
ou com serviço Redis):

```bash
pip install "celery[redis]"          # NÃO está no requirements.txt
export REDIS_URL=redis://localhost:6379/0
celery -A app.tasks.celery_app worker --loglevel=INFO   # processo separado
```

Com `REDIS_URL` setado, `POST .../knowledge/pdf|text` responde **202**
(`{"status":"queued","task_id":...}`) e o worker processa em background. Sem broker,
cai no síncrono automaticamente (`app/tasks.py`). O PDF vai como base64 na fila —
o worker não depende de arquivo local do web.

## Observabilidade

- Formato de log (root reconfigurado em `logging_ctx.configure_logging`):
  `… INFO [req=<id> tenant=<id>] blip-agent.<modulo> <msg>`.
- `req` vem do header `X-Request-ID` (ou é gerado) e volta na resposta — case
  log↔chamada. `tenant` é extraído do path `/v1/tenants/{id}/...`.
- Ajuste verbosidade com `LOG_LEVEL` (`DEBUG`/`WARNING`). Tabela de "o que cada
  logger conta" em `docs/DEBUG.md`.
- Erros tratados **não vazam** detalhe ao usuário: o `str(e)` fica só no log.

## Rodar local

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows (bash: source .venv/Scripts/activate)
pip install -r requirements.txt
cp .env.example .env              # preencha as chaves
uvicorn server:app --reload --port 8000   # painel em http://localhost:8000
```

## Checklist de deploy

- [ ] `GROQ_API_KEY`, `JINA_API_KEY`, `ADMIN_API_KEY` definidas no provedor.
- [ ] `DB_DIR` apontando para Volume montado (senão, dados efêmeros).
- [ ] `/health` responde `ok` e lista os tenants esperados após o deploy.
- [ ] `SEED_DEMO=0` se não quiser o agente demo em produção.
- [ ] Sem `JINA_API_KEY`: a app sobe, mas RAG degrada (busca vazia; ingestão 503).
- [ ] Se for usar fila: serviço Redis + worker Celery + `celery[redis]` instalado.

CORS hoje é `allow_origins=["*"]` (ver o skill `seguranca` para o endurecimento).
