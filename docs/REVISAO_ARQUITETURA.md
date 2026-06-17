# Revisão de arquitetura — blip-agent

Análise dos 19 pontos de feedback da empresa, validados **contra o código real**,
com criticidade, correções, grafo de dependências e plano de execução em fases —
agora com o **status de implementação** (atualizado em **2026-06-17**).

> Metodologia: cada cluster de pontos foi revisado por um analista lendo os
> arquivos citados; uma síntese montou o grafo de dependências; e uma revisão
> adversarial validou criticidades e achou erros na própria análise (ver
> §"Correções da revisão"). As correções já estão incorporadas.
>
> **Decisão do time:** este protótipo vira a **arquitetura final**, então **todos
> os 19 pontos estão no escopo** — inclusive os que a 1ª análise sugeriu adiar
> como "over-engineering" (RBAC/CASL, feature flags, workers/Celery, camada de
> services, split de schemas). Aquela recomendação de adiar foi **substituída**
> por esta decisão (ver §"Escopo: arquitetura final").

---

## Status de implementação (2026-06-17)

Execução em **11 fases**, na ordem de dependência. **Todas as 11 fases concluídas
e validadas** (import + smoke de migração legada + fluxo multi-tenant fresco +
wiring HTTP via TestClient: RBAC, isolamento cross-tenant e feature flags).

| Fase | Pontos | Status | Entrega |
|------|--------|--------|---------|
| 1 — Tipos e contratos | 3, 2, 13, 14, 16 | ✅ **Feito** (validado) | `app/domain.py` (`AgentConfig`, `AgentResult`, `ChatMessage`, `ProductRow`); agentes retornam `AgentResult`; `self.llm: LLMClient`; `complete_with_tools -> ChatCompletion`; dict opaco eliminado da cadeia |
| 2 — Split de schemas | 11 | ✅ **Feito** | `app/schemas/` pacote (agent/chat/product/knowledge/tenant/shared) + `__init__` re-exporta |
| 3 — Camada de dados | 15, 16 (+5) | ✅ **Feito** (validado) | `app/repositories/` (Agent/Product/Tenant/User/Membership); `db.transaction()`/`read_connection()`; **WAL**; escopo por tenant/agente como invariante; `app/messages.py` (pt 5) |
| 4 — Erros centralizados | 10 | ✅ **Feito** (validado) | `app/errors.py` (`AppError`); handler único em `main.py`; regra degrade-vs-propagate (C2) |
| 5 — Registry de tools | 17 | ✅ **Feito** (validado) | `app/tools.py` registry + args Pydantic; `PRODUCT_TOOLS` derivado da mesma fonte |
| 7 — Orchestrator | 18 | ✅ **Feito** (validado) | `_select_agent` extraído; `Orchestrator` cacheado por `AgentConfig` (`lru_cache`) |
| 6 — Camada de services | 12 | ✅ **Feito** (validado) | `app/services/` (Agent/Tenant/Product/Knowledge) injetados via `Depends`; routers só fazem HTTP↔service |
| 8 — Entidade tenant | 19 | ✅ **Feito** (validado) | `tenants`/`users`/`memberships`; `agents.tenant_id`+`slug`; migração legada p/ tenant `default` (rebuild de `agents`, descarta `api_key` por agente); `id` prefixado `{tenant}__{slug}`; `rag.db` `tenant_id`→`agent_id`; rotas `/v1/tenants/...` |
| 9 — RBAC + feature flags | 8 | ✅ **Feito** (validado) | `Principal` + `require_member`/`require_owner`/`require_platform_admin`; flags `rag_enabled`/`external_products` aplicadas em runtime (FAQAgent/catalog) e na validação; `GET` de agentes não expõe segredo |
| 10 — Observabilidade | 9, 6 | ✅ **Feito** (validado) | `request_id` (middleware) + `contextvar` de tenant no formatter; `LOG_LEVEL`; `docs/DEBUG.md`; log no caminho feliz do OrderAgent; `error=str(e)`/`ChatResponse.error` removidos |
| 11 — Workers/concorrência | 7 | ✅ **Feito** | `app/tasks.py` Celery+Redis: ingestão enfileira (202) com **fallback síncrono** sem broker; WAL já feito na Fase 3 |

**Pontos positivos preservados (1, 4, 6):** `BaseAgent` segue ABC com
`@abstractmethod` mantendo o contrato `execute`; o padrão use-case `execute()`
segue idêntico em todas as subclasses; o logger hierárquico `blip-agent.*` foi
mantido e **enriquecido** com correlação `req`/`tenant` na Fase 10.

**Refinamento concluído:** o `error=str(e)` saiu do corpo de erro do
`Orchestrator` e o campo `ChatResponse.error` foi removido — o detalhe técnico
fica só no log (correlacionado por `req`/`tenant`); a fala do bot usa a mensagem
genérica centralizada.

---

## Resumo executivo

O blip-agent é um **protótipo bem-arquitetado para o estágio em que estava** —
`BaseAgent`, `Orchestrator` com `classifier` extraído, logging hierárquico e o
uso **correto** de `asyncio.to_thread` para o I/O bloqueante de Groq/Jina são
decisões sólidas que foram **endurecidas, não desfeitas**.

O problema **real** para virar SaaS de produção era triplo — e a fundação já foi
atacada:

1. **Contratos internos eram dicts opacos com magic strings (ponto 3)** →
   **resolvido** (Fase 1): tipos em `app/domain.py`, propagados a retorno de
   agente (2), inputs (13), cliente LLM (14) e camada de dados (16).
2. **Não existia camada de dados (ponto 15)** → **resolvido** (Fase 3):
   `app/repositories/` concentra todo o SQL e o `WHERE agent_id=?` virou
   invariante de classe — fecha o vetor de vazamento entre tenants e desacopla do
   SQLite (caminho para Postgres).
3. **Tenant fundido com agent (ponto 19)** → **pendente** (Fase 8): é a causa-raiz
   do ponto 8 (RBAC) e a maior mudança restante.

---

## Tabela de criticidade (pós-revisão adversarial) + status

| # | Ponto | Criticidade | Status |
|---|-------|-------------|--------|
| 19 | Tenant fundido com agent (deveria ser tenant com N agents) | 🟠 Alto (fundacional) | ✅ Fase 8 |
| 15 | Sem repositório; SQL cru; tenant scoping manual | 🟠 Alto (fundacional) | ✅ Fase 3 |
| 3 | Magic strings nas chaves de dicts (causa-raiz) | 🟠 Alto | ✅ Fase 1 |
| 2 | Retorno do BaseAgent não tipado (dict genérico) | 🟠 Alto | ✅ Fase 1 |
| 14 | `self.llm` e retorno de tools não tipados | 🟠 Alto | ✅ Fase 1 |
| 16 | Queries/camada de dados sem tipo | 🟠 Alto | ✅ Fase 3 |
| 10 | Sem camada única de erros; status codes espalhados | 🟠 Alto | ✅ Fase 4 |
| 8 | Sem RBAC/feature flags; auth a endurecer (ADMIN_API_KEY global, `GET /v1/agents` expõe api_keys) | 🟠 Alto (após 19) | ✅ Fase 9 |
| 5 | Strings de erro/copy espalhadas e divergentes | 🟡 Médio | ✅ Fase 3 |
| 13 | Inputs estruturados não tipados | 🟡 Médio | ✅ Fase 1 |
| 9 | Logging sem correlação por requisição/tenant; sem DEBUG.md | 🟡 Médio | ✅ Fase 10 |
| 7 | Threads vs workers (Celery) | 🟡 Médio | ✅ Fase 11 |
| 12 | Routers sem camada de service/handler | 🟡 Médio | ✅ Fase 6 |
| 18 | `orchestrator.py` / agentes recriados por request | 🟢 Baixo | ✅ Fase 7 |
| 11 | `schemas.py` único | 🟢 Baixo | ✅ Fase 2 |
| 17 | Estilo das tools vs LangGraph | 🟢 Baixo | ✅ Fase 5 |
| 1 | BaseAgent (padronização) | ✅ Positivo | 🔒 Preservado |
| 4 | Padrão use-case `execute()` | ✅ Positivo | 🔒 Preservado |
| 6 | Logger hierárquico bem feito | ✅ Positivo | 🔒 Preservado (ampliado na Fase 10) |

> Nota sobre segurança (ponto 8): a 1ª análise chegou a separar um "8a" de
> credencial como crítico imediato. Por decisão de não criar pontos fora dos 19,
> o endurecimento de auth foi **dobrado dentro do ponto 8** e será feito junto da
> RBAC (Fase 9): credencial no nível do tenant e parar de expor api_keys na
> listagem.

---

## Correções da revisão (e como foram resolvidas)

A revisão adversarial achou três coisas que mudaram o plano. Estado de cada uma:

### C1. O ponto 2, como descrito, quebraria em runtime — ✅ resolvido
`ChatResponse` exige `intent` e `agent_used`, que **nenhum agente produz** (são
injetados pelo `Orchestrator`). Um `AgentResult` único faria `ChatResponse`
**explodir**. **Resolução (Fase 1):** dois contratos — `AgentResult` (saída do
agente) ≠ `ChatResponse` (API). O orchestrator faz `agent_result.to_dict()` e
injeta `intent/agent_used/confidence`. Por isso 2 e 18 foram feitos juntos.

### C2. Pontos 10 e 4 queriam coisas opostas no chat — ✅ resolvido
**Resolução (Fase 4):** regra explícita — no **chat**, erros de LLM/embedding
**degradam** para 200 + handoff (o `except` do `Orchestrator` captura); em
**admin/config/knowledge/products**, `AppError` **propaga** com status tipado via
o handler único. (Falta só remover o `error=str(e)` residual — Fase 10.)

### C3. O ponto 8 era segurança subestimada — ✅ resolvido
**Resolução (Fase 9):** a credencial subiu para o **tenant** (e há chave por
usuário com papel); a `ADMIN_API_KEY` virou superusuário **de plataforma**, não
mais o passe-livre de qualquer agente. O `GET` de agentes **não expõe mais
segredo** (o `AgentConfig`/`AgentPublic` não tem `api_key`). Auth resolvida em
`deps._resolve_principal` (admin/owner/member) e validada por TestClient.

### Ajuste de evidência (ponto 19) — ✅ resolvido na Fase 8
`rag.db` usava `tenant_id` (na verdade o id do agente) e `core.db` usava
`agent_id`. A migração **renomeou** `chunks.tenant_id`→`agent_id` (valor
preservado), reconciliando a nomenclatura sem mover dados.

---

## Grafo de dependências

```
3 (tipos base) ──┬─► 2 (saída agente) ──► (acoplado a) 18 (orchestrator)   [✅]
                 ├─► 13 (inputs)                                            [✅]
                 ├─► 14 (LLM tipado) ─┐                                     [✅]
                 ├─► 16 (dados tipados)│                                    [✅]
                 └─► 17 (tools) ◄──────┘   (17 depende de 13 e 14)          [✅]

15 (repositório) ──┬─► 12 (services)                                        [✅]
                   ├─► 10 (camada de erros) ◄── 5 (copy centralizada)       [✅]
                   ├─► 7 (concorrência/WAL + Celery)                         [✅]
                   └─► (facilita) 19                                         [✅]

19 (entidade tenant) ──┬─► 8 (RBAC + feature flags)                         [✅]
                       └─► 9 (correlação de log por tenant)                 [✅]

1, 4, 6 — positivos, preservados
```

**Fundacionais:** 3 ✅, 15 ✅, 19 ✅, 5 ✅.

---

## Plano em fases (atual)

**Todas as 11 fases concluídas.** As fases 6, 8 e 9 foram entregues juntas (a
remodelagem multi-tenant compartilha rotas/auth), seguidas de 10 (observabilidade)
e 11 (workers).

- **Fase 1 — Tipos compartilhados** ✅ — `domain.py`; `AgentResult`≠`ChatResponse`
  (C1); `2+18` juntos; `13/14/16`; registry de tools `17`.
- **Fase 2 — Split de schemas** ✅ — `app/schemas/` pacote (+ `tenant.py`).
- **Fase 3 — Camada de dados + copy** ✅ — `repositories/`, `transaction()`, WAL,
  scoping invariante; `messages.py` (pt 5).
- **Fase 4 — Erros únicos** ✅ — `errors.py` + handler; regra degrade/propagate (C2).
- **Fase 5 — Registry de tools** ✅ — Pydantic args.
- **Fase 7 — Orchestrator** ✅ — `_select_agent` + cache por agente.
- **Fase 6 — Services** ✅ — `app/services/` (Agent/Tenant/Product/Knowledge)
  consumindo os repositórios, injetados via `Depends`; routers ficaram finos.
- **Fase 8 — Entidade tenant (XL)** ✅ — `tenants`/`users`/`memberships`;
  `agents.tenant_id`+`slug`; migração dos agentes atuais para o tenant `default`
  (rebuild de `agents`, `api_key` por agente descartada); `id` prefixado
  `{tenant}__{slug}` (resolve colisão de slug); `rag.db` `tenant_id`→`agent_id`.
  Rotas remodeladas (`/v1/tenants/{tenant_id}/agents/{slug}/...`).
- **Fase 9 — RBAC + feature flags** ✅ — `Principal` + papéis `owner`/`member`
  (membership) + `admin` de plataforma; flags `rag_enabled`/`external_products`
  aplicadas; auth endurecida (sem api_key por agente, sem exposição na listagem).
- **Fase 10 — Observabilidade** ✅ — `request_id` (middleware) + `contextvar` de
  tenant no formatter; `LOG_LEVEL` por env; `docs/DEBUG.md`; log no caminho feliz
  do OrderAgent; `error=str(e)`/`ChatResponse.error` removidos.
- **Fase 11 — Workers/concorrência** ✅ — `app/tasks.py` Celery+Redis: ingestão
  enfileira e retorna **202**, com **fallback síncrono** quando não há broker
  (ativação documentada em `docs/DEBUG.md`).

### Validação executada (smoke)

- **Migração legada:** `core.db` no schema antigo (agente com `api_key`, sem
  tenant) → reconstruído multi-tenant; produtos e RAG preservados; `rag.db`
  renomeado; idempotente ao re-rodar.
- **Fluxo fresco:** default+demo semeados; dois tenants com agente de mesmo slug
  sem colisão (`acme__loja`≠`beta__loja`); isolamento de produtos; conflito de
  slug no mesmo tenant; flag `external_products` bloqueando modo externo.
- **RBAC (TestClient):** criar tenant exige admin (401→201); `GET`/`POST` de
  agentes sem chave = 401; owner cria agente (201, **sem `api_key` no corpo**);
  member não cria (403) mas lista (200); chave de um tenant em agente de outro = 403.

---

## Escopo: arquitetura final (decisão do time)

Como o protótipo vira a arquitetura final, **os 19 pontos estão todos no escopo**.
As decisões tomadas para as fases que dependiam de definição de produto/infra:

- **Modelo de tenant (Fase 8):** tenant é dono de **N agents**; entidades
  completas (`tenants`/`users`/`memberships`); agentes atuais migram para um
  tenant `default`; credencial sobe para o nível do tenant; `agent_id` prefixado
  por tenant.
- **RBAC + flags (Fase 9):** começar com **2 papéis** (`owner`/`member`) e flags
  mínimas (`rag_enabled`, `external_products`); planos podem vir depois.
- **Workers (Fase 11):** **Celery + Redis** no código, com **fallback síncrono**
  se não houver broker configurado; instruções de ativação na documentação
  (deploy fora do Railway).

> As recomendações de "adiar/over-engineering" da 1ª análise (não fazer RBAC com
> vários papéis, não adotar Celery, não quebrar schemas, etc.) ficam **registradas
> como histórico**, mas foram **substituídas** por esta decisão de escopo.
