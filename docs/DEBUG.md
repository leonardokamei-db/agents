# Guia de depuração e operação — blip-agent

Como observar, depurar e operar o backend multi-tenant (pontos 9, 7 da revisão).

## Logs correlacionados (ponto 9)

Todo log sai no formato:

```
2026-06-17 14:42:04  INFO  [req=66eafb5c99fa tenant=acme] blip-agent.services.agents  Agente criado: acme__loja
```

- `req=<id>` — correlaciona todas as linhas de **uma requisição**. O id vem do
  header `X-Request-ID` (se o cliente enviar) ou é gerado pelo middleware. Ele
  também volta no header `X-Request-ID` da resposta — para casar log ↔ chamada.
- `tenant=<id>` — extraído do path `/v1/tenants/{tenant_id}/...`.
- Fora de uma requisição (boot, worker), ambos saem como `-`.

Implementação: contextvars + filtro de logging em [app/logging_ctx.py](../app/logging_ctx.py),
preenchidos pelo middleware em [app/main.py](../app/main.py).

### Nível de log

Controle pela env `LOG_LEVEL` (default `INFO`):

```bash
LOG_LEVEL=DEBUG   # mais verboso
LOG_LEVEL=WARNING # só avisos/erros
```

### O que cada logger conta

| Logger | O que loga |
|--------|-----------|
| `blip-agent.orchestrator` | intent, confiança, agente escolhido, handoff, tokens |
| `blip-agent.classifier` | scores por intenção e mensagem (truncada) |
| `blip-agent.faq` | atalho RAG vs RAG+LLM, distância do melhor chunk |
| `blip-agent.order` | caminho feliz: tools chamadas, tokens, se reservou |
| `blip-agent.services.*` | criação de tenant/agente/membership |
| `blip-agent.db` | migração multi-tenant e criação do tenant default |
| `blip-agent.tasks` | enfileiramento Celery / fallback síncrono |

> Erros tratados **não vazam** detalhe técnico ao usuário: o chat degrada com uma
> mensagem genérica (`ERROR_INTERNAL`) e o `str(e)` fica **só no log** (com o
> `req`/`tenant` para rastrear). O `ChatResponse` não tem mais campo `error`.

## Erros da API

Todo erro de domínio sai padronizado pelo handler único:

```json
{ "code": "not_found", "detail": "Agente 'x' não encontrado neste tenant." }
```

`code` ∈ `not_found` (404), `conflict` (409), `validation_error` (400),
`unauthorized` (401), `forbidden` (403), `embedding_unavailable` (503),
`internal_error` (500). Definições em [app/errors.py](../app/errors.py).

## Autenticação (RBAC — ponto 8)

| Credencial | Header | Pode |
|-----------|--------|------|
| `ADMIN_API_KEY` (plataforma) | `X-Admin-Key` (rotas de plataforma) e `X-API-Key` (rotas de tenant) | tudo |
| api_key do tenant | `X-API-Key` | owner do próprio tenant (chat/consumo + gestão) |
| api_key de usuário | `X-API-Key` | papel da membership: `owner` ou `member` |

`member` = leitura + chat + conteúdo (knowledge/produtos). `owner`/`admin` =
+ criar/excluir agentes e gerir membros.

Diagnóstico rápido:
- **401** → chave ausente/inválida (`X-API-Key`/`X-Admin-Key`).
- **403** → chave válida mas sem permissão (tenant errado, ou `member` tentando gerir).
- **404** → agente não existe **naquele tenant** (isolamento ok).

## Workers / fila de ingestão (ponto 7)

Por padrão **não há broker** → a ingestão de PDF/texto roda **síncrona** no
processo web (resposta 200 com `chunks_created`). Comportamento idêntico ao atual.

Para descarregar a ingestão (deploy fora do Railway):

```bash
pip install "celery[redis]"
export REDIS_URL=redis://localhost:6379/0   # liga o modo fila

# processo web (uvicorn) normalmente, e em paralelo:
celery -A app.tasks.celery_app worker --loglevel=INFO
```

Com `REDIS_URL` setado, `POST .../knowledge/pdf|text` responde **202** com
`{"status":"queued","task_id":...}` e o worker processa em background. Sem broker,
o código cai no caminho síncrono automaticamente — ver [app/tasks.py](../app/tasks.py).

## Bancos e migração

- `core.db` — tenants, users, memberships, agents, products.
- `rag.db` — chunks + embeddings (sqlite-vec), escopados por `agent_id`.
- Aponte `DB_DIR` para um volume persistente em produção.

A migração roda **sozinha no boot** (`init_db`/`init_rag_db`, idempotentes):
um `core.db` legado (agente com `api_key`, sem tenant) é reconstruído no modelo
multi-tenant — agentes vão para o tenant `default` (cuja `api_key` é logada uma
vez), preservando ids/produtos/RAG. No `rag.db`, a coluna `tenant_id` é renomeada
para `agent_id`.

## Checagem rápida de saúde

```bash
curl -s localhost:8000/health
# {"status":"ok","model":"...","celery":false,"tenants":["default"]}
```
