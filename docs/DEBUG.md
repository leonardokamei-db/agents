# Guia de depuração e operação — blip-agent

Como observar, depurar e operar o backend multi-tenant (pontos 9, 7 da revisão).

## Logs correlacionados (ponto 9)

Todo log sai no formato:

```
2026-06-17 14:42:04  INFO  [req=66eafb5c99fa tenant=acme] blip-agent.services.agents  Agente criado: acme__loja
```

- `req=<id>` — correlaciona todas as linhas de **uma requisição**. O id vem do
  header `X-Request-ID` (se o cliente enviar) ou é gerado pelo wrapper de rota. Ele
  também volta no header `X-Request-ID` da resposta — para casar log ↔ chamada.
- `tenant=<id>` — extraído do path `/v1/tenants/{tenant_id}/...`.
- Fora de uma requisição (boot, scripts), ambos saem como `-`.

Implementação: `AsyncLocalStorage` em [src/server/logging.ts](../src/server/logging.ts),
aberto pelo wrapper em [src/server/http/route.ts](../src/server/http/route.ts).

### Nível de log

Controle pela env `LOG_LEVEL` (default `INFO`):

```bash
LOG_LEVEL=DEBUG   # mais verboso
LOG_LEVEL=WARNING # só avisos/erros
```

### O que cada logger conta

| Logger | O que loga |
|--------|-----------|
| `blip-agent.orchestrator` | intent derivado das skills, handoff, tokens, tools |
| `blip-agent.skilled` | fast-paths (escalonamento/atalho RAG), loop de tools, retries |
| `blip-agent.rag` | ingestão (nº de chunks), atalhos de busca |
| `blip-agent.catalog` | reserva de estoque, falhas da API externa |
| `blip-agent.llm` | erros da Anthropic (conexão, rate limit) |
| `blip-agent.services.*` | criação de tenant/agente/membership |
| `blip-agent.bootstrap` | criação do tenant default + seed do agente demo |

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
`internal_error` (500). Definições em [src/server/errors.ts](../src/server/errors.ts).

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

## Ingestão de conhecimento

A ingestão de PDF/texto (extração + embeddings + escrita) roda **síncrona** no
request e responde **200** com `chunks_created`. Celery e Redis foram **removidos**
na migração para TS. Para fila assíncrona sem Redis no futuro (ex.: pg-boss sobre o
mesmo Postgres), o ponto de extensão é `src/server/services/knowledge.ts`.

PDFs são extraídos com `unpdf` (puro JS) em `src/server/rag.ts`.

## Banco

Tudo num único **Postgres + pgvector**:
- relacional — tenants, users, memberships, agents, products;
- vetorial — `chunks` com coluna `embedding vector(384)`, escopada por `agent_id`.

O schema é criado no boot/deploy por `npm run db:setup` (`CREATE EXTENSION vector` +
DDL idempotente em `src/server/db/ddl.ts`). **Greenfield:** não há migração de
bancos legados. Para inspecionar:

```bash
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "select agent_id, count(*) from chunks group by 1;"
```

## Checagem rápida de saúde

```bash
curl -s localhost:3000/health
# {"status":"ok","model":"...","tenants":["default"]}
```
