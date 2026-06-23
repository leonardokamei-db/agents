# Arquitetura — blip-agent

Plataforma multi-tenant de agentes de atendimento. Um **tenant** (cliente) é dono
de **N agentes**; cada agente tem endpoint de chat próprio, base de conhecimento
(RAG) própria, regras de negócio editáveis e catálogo de produtos opcional. A
proposta é funcionar como um "mini Blip Studio": o cliente configura agentes pela
interface/API e os consome via endpoints REST, sem um time interno dedicado a
cada bot.

Usuários se vinculam a um tenant por uma **membership** com papel (`owner`/
`member`) — RBAC mínimo. A credencial de consumo vive no nível do **tenant**.

- **Stack:** FastAPI (Python 3.12) · Groq (LLM) · Jina (embeddings) · SQLite + sqlite-vec (dados e vetores) · Celery+Redis opcional (fila de ingestão)
- **Deploy:** Railway (NIXPACKS), `uvicorn server:app` — `server.py` apenas reexporta `app.main:app`; bancos SQLite em volume persistente (`DB_DIR`)
- **Front-end:** `client.html` — painel admin estático servido pela própria API em `/` (usa a `ADMIN_API_KEY` como superusuário)
- **Camadas:** routers (HTTP) → services (regra de negócio) → repositories (SQL) → domínio tipado

> O `README.md` na raiz ainda descreve a arquitetura **antiga** (rotas `/v1/agents`,
> `schemas.py`/`tenants.py`/`routers/admin.py` — arquivos já removidos). Em caso de
> divergência, **este documento e o código são a fonte de verdade.**

---

## 1. Visão de componentes

```
                          ┌─────────────────────────────┐
   Navegador / cliente    │        client.html          │
   (painel admin ou       │  painel admin + chat de teste│
    integração)           └──────────────┬──────────────┘
                                         │ HTTPS (REST + X-Admin-Key / X-API-Key)
                          ┌──────────────▼──────────────┐
                          │           FastAPI            │  app/main.py
                          │  middleware: req_id + tenant │  (X-Request-ID)
                          │  exception handler único     │  AppError → status tipado
                          │  ┌────────────────────────┐  │
                          │  │ routers/               │  │  RBAC: admin /
                          │  │  tenants · agent · chat│  │  owner / member
                          │  │  knowledge · products  │  │  (deps.py)
                          │  └───────────┬────────────┘  │
                          │     services/ → repositories/ │  regra de negócio → SQL
                          │              ▼               │
                          │       Orchestrator           │  prepara o contexto e
                          │   (cacheado por AgentConfig) │  delega ao agente
                          │  ┌────────────────────────┐  │
                          │  │ SkilledAgent (flexível)│  │  o LLM escolhe a skill
                          │  │  + FallbackAgent       │  │  (function calling)
                          │  ├────────────────────────┤  │
                          │  │ skills/                │  │
                          │  │  knowledge · catalog   │  │
                          │  │  support (escalate)    │  │
                          │  └───┬─────────┬──────┬───┘  │
                          └──────│─────────│──────│──────┘
                                 ▼         ▼      ▼
                          ┌──────────┐ ┌──────┐ ┌─────────┐
                          │  rag.py  │ │llm.py│ │catalog. │
                          │ sqlite-  │ │ Groq │ │ py      │
                          │ vec      │ └──┬───┘ └────┬────┘
                          └────┬─────┘    │          │
                               │          │     ┌────┴─────┐
                          ┌────▼────┐     │     │ interno  │ SQLite
                       embeddings   │  Groq API │   OU     │
                        (Jina API)──┘           │ externo  │ API REST do cliente
                                                └──────────┘
```

Mapa de arquivos (a ordem de camadas está documentada em `app/__init__.py`):

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Config | `app/config.py` | Env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, modelos, paths, LOG_LEVEL, REDIS_URL) |
| API | `app/main.py`, `app/routers/*` | Endpoints, RBAC, CORS, middleware de contexto, handlers de erro, `/health`, ciclo de vida |
| Domínio | `app/domain.py` | Tipos tipados (Tenant, User, Membership, Principal, AgentConfig, ProductRow, AgentResult, ChatMessage) |
| Schemas | `app/schemas/*` | Modelos Pydantic por domínio (agent/chat/product/knowledge/tenant/shared) |
| Services | `app/services/*` | Regra de negócio (Agent/Tenant/Product/Knowledge), injetada via `Depends` |
| Dados | `app/repositories/*`, `app/db.py` | Todo o SQL + schema + migração multi-tenant |
| Erros / Copy | `app/errors.py`, `app/messages.py` | Hierarquia única de `AppError`; copy pt-BR voltada ao usuário (handoff, escalonamento, degradação) |
| Orquestração | `app/orchestrator.py` | Trunca histórico, aplica limite de turnos (→ fallback) e delega ao agente flexível |
| Agentes | `app/agents/*` | Agente flexível (`SkilledAgent`, dirigido por skills) + fallback estático |
| Skills | `app/skills/*` | Capacidades discretas que o agente invoca via function calling (knowledge_search, catálogo, check_catalog, escalate_to_human); interface pronta para virar Lambda |
| Prompts | `app/prompts.py` | System prompts compactos (base + regras só das skills habilitadas) |
| RAG | `app/rag.py`, `app/embeddings.py` | Chunking, ingestão, busca vetorial, embeddings |
| Catálogo | `app/catalog.py` | Produtos (SQLite interno OU API externa) + health check do catálogo |
| Workers | `app/tasks.py` | Ingestão via Celery+Redis (202) com fallback síncrono |
| Observabilidade | `app/logging_ctx.py` | Correlação de log por `request_id` + `tenant` (contextvars + filtro) |
| Texto | `app/textutil.py` | Normalização/tokenização (`normalize`, `word_set`, `slugify`) |

---

## 2. Multi-tenancy: como nasce um endpoint

Um agente é uma linha na tabela `agents`, **sempre dentro de um tenant**. Criar o
tenant gera sua `api_key` master e o primeiro usuário `owner`; criar o agente já
**"abre" o endpoint** — sem geração de código nem redeploy. As rotas resolvem o
agente pelo par `(tenant_id, slug)` a cada requisição (`AgentRepository.get`):

```
# Plataforma (X-Admin-Key)
POST   /v1/tenants                                    (admin)  cria tenant → api_key + owner (chaves exibidas 1x)
GET    /v1/tenants                                    (admin)  lista tenants (sem segredos)
DELETE /v1/tenants/{tid}                              (admin)  exclui tenant (cascade + RAG)

# Tenant / membros (X-API-Key)
GET    /v1/tenants/{tid}                              (member) dados do tenant
GET    /v1/tenants/{tid}/members                      (owner)  lista membros
POST   /v1/tenants/{tid}/members                      (owner)  convida usuário → gera api_key
DELETE /v1/tenants/{tid}/members/{user_id}            (owner)  remove membro (não deixa remover o último owner)

# Agentes, aninhados no tenant (X-API-Key)
POST   /v1/tenants/{tid}/agents                       (owner)  cria agente → abre o endpoint
GET    /v1/tenants/{tid}/agents                       (member) lista agentes do tenant
GET    /v1/tenants/{tid}/agents/{slug}                (member) configuração pública do agente
PUT    /v1/tenants/{tid}/agents/{slug}/config         (owner)  edita prompt/regras/turnos/flags
DELETE /v1/tenants/{tid}/agents/{slug}                (owner)  exclui agente (produtos por cascade + RAG)
POST   /v1/tenants/{tid}/agents/{slug}/chat           (member) conversa (a "porta" do agente)
*      /v1/tenants/{tid}/agents/{slug}/knowledge/...  (member) sobe/gere FAQ (RAG); 202 se enfileirado
*      /v1/tenants/{tid}/agents/{slug}/products[/{id}](member) GET sempre; CRUD só no modo interno

# Operacional
GET    /health                                        (público) status, modelo, celery on/off, tenants
GET    /                                              (público) serve o client.html
```

**Autenticação + RBAC** (`app/routers/deps.py`, ponto 8). Uma só função
`_resolve_principal` produz um `Principal` tipado (`role` ∈ admin/owner/member):

- `X-Admin-Key` = `ADMIN_API_KEY` — admin de **plataforma** (cria/exclui tenants; superusuário em qualquer tenant).
- `X-API-Key` = api_key do **tenant** — `owner` do próprio tenant (chave master/consumo).
- `X-API-Key` = api_key de **usuário** — papel vindo da membership (`owner` | `member`).

Dependências reutilizáveis: `require_platform_admin`, `require_owner`,
`require_member`. `member` tem leitura + chat + conteúdo (knowledge/produtos);
`owner`/`admin` gerenciam agentes e membros (`Principal.can_manage`).

Cada agente tem `id` **globalmente único** (`{tenant}__{slug}`, resolvendo colisão
de slug entre tenants). O isolamento de dados é por `agent_id` (produtos e chunks
RAG filtram por agente, invariante da camada de repositórios) e por `tenant_id`
(agentes/membros), então nenhum tenant enxerga dados de outro — validado por smoke
(chave de um tenant em agente de outro → 403; agente inexistente naquele tenant → 404).

---

## 3. Fluxo de uma requisição de chat (agente flexível + skills)

**O modelo mudou:** não há mais um classificador de palavra-chave escolhendo um
entre cinco agentes rígidos. Agora existe **um único agente flexível**
(`SkilledAgent`) que recebe um **conjunto de skills** e deixa o **LLM decidir qual
chamar** (function calling). O que era um "agente de FAQ" virou a skill
`knowledge_search`; o que era o "agente de pedidos" virou as skills de catálogo;
o escalonamento de suporte virou a skill `escalate_to_human`. Isso elimina o
gargalo de roteamento documentado na §10/§11 (palavras como "custa"/"cancelar"
sequestravam perguntas) — quem roteia agora é o modelo, com a pergunta inteira em
contexto.

`Orchestrator.process()` (`app/orchestrator.py`) continua **cacheado por
`AgentConfig`** via `lru_cache` em `app/routers/agent.py` (`_orchestrator_for`):
`AgentConfig` é `dataclass(frozen=True)` (e `skills` é uma **tupla**, para manter
a hashabilidade), então editar a config gera chave nova e invalida o cache; o
`LLMClient` é singleton. O fluxo ficou fino:

1. **Trunca o histórico** para as últimas `HISTORY_LIMIT` mensagens (padrão **5**).
2. **Limite de turnos:** histórico total acima de `max_turns` (padrão 15) →
   `FallbackAgent` (handoff estático, 0 tokens).
3. **Senão, executa o `SkilledAgent`**, que faz:
   - **Fast-path 1 — escalonamento (0 token):** palavra-chave forte ("reembolso",
     "cancelar", ...) dispara `escalate_to_human` direto, sem LLM (`support_escalation`).
   - **Fast-path 2 — atalho RAG (0 token de LLM):** se `knowledge_search` está
     habilitada, faz uma busca; match fortíssimo (dist. L2 ≤ 0.90) responde o chunk
     literal (`faq_shortcut`), sem LLM (custa só um embedding).
   - **Caso geral — loop de function calling:** apresenta as skills habilitadas
     como *tools* ao LLM; enquanto o modelo pede tools, executa cada skill, devolve
     o JSON e chama o modelo de novo (teto `MAX_TOOL_ITERATIONS`, retries para
     `tool_use_failed`). O modelo compõe a resposta final em texto.
4. **Anexa metadados:** `agent_used` (`skilled`/`fallback`), `intent` derivado das
   skills usadas (para o painel/avaliação), tokens, tools chamadas, fontes RAG.
5. Qualquer exceção vira handoff gracioso (`ERROR_INTERNAL`) — o `str(e)` fica
   **só no log**, nunca na resposta; a request nunca cai.

### Skills — a unidade de capacidade (`app/skills/`)

Uma **skill** é uma capacidade discreta com contrato único: `nome + descrição +
modelo Pydantic de args + handler → SkillResult`. Schema (function calling) e
dispatch saem da **mesma fonte** (o registry em `app/skills/base.py`), então nunca
dessincronizam — é a generalização do antigo `app/tools.py`.

| Skill | Categoria | O que faz | Custo |
|---|---|---|---|
| **knowledge_search** | knowledge | Busca na base (RAG). Atalho de 0 token em match fortíssimo; senão o LLM compõe com os chunks | 0 ou contexto |
| **check_stock / search_products / list_products** | catalog | Consulta catálogo/estoque/preço (nunca inventa) | dado JSON |
| **reserve_stock** | catalog | Reserva (só interno); sucesso → handoff p/ pagamento | dado JSON |
| **check_catalog** | catalog | **(nova)** Verifica o catálogo do cliente: configuração + acessibilidade | dado JSON |
| **escalate_to_human** | support | Handoff para atendente humano (skill terminal) | 0 |

**Quais skills um agente tem?** `app/skills/enabled_skills_for(agent)`: se
`agent.skills` é explícito, usa-o; se vazio, **deriva das feature flags**
(`rag_enabled` → knowledge; `product_mode != none` → catálogo; suporte/gerais
sempre). Assim, todo agente que já existia segue funcionando sem migração, e novos
agentes podem declarar exatamente suas skills (editável pelo endpoint de config,
sem redeploy).

### Caminho para serverless (AWS Lambda) — desenhado, não implementado

Hoje **tudo roda em processo** (`LocalSkill`, `kind="local"`) — é o "mais simples
que Lambda" do protótipo. Mas o contrato já é **remoteável**: `SkillContext` e
`SkillResult` carregam só dados serializáveis e os args são Pydantic. Para mover
uma skill para Lambda/HTTP no futuro, basta uma subclasse `RemoteSkill` cujo
`invoke()` chame o backend remoto com o mesmo `(ctx, args) → SkillResult`; o
registry, o loop do agente e a geração de schema **não mudam** — só o transporte
daquela skill. A decisão de fato (Lambda ou não) fica para depois do protótipo.

`AgentResult` (saída do agente) ≠ `ChatResponse` (contrato da API): `agent_used`,
`intent` e `confidence` são preenchidos pelo Orchestrator. Sem classificador,
`intent` agora é **derivado das skills efetivamente usadas** (não mais um palpite)
e `confidence` é 1.0 (a decisão é do LLM).

---

## 4. RAG (base de conhecimento)

`app/rag.py` + `app/embeddings.py`:

- **Ingestão:** PDF/texto → chunking por seção (um tópico por chunk; cabeçalhos
  e rodapés repetidos de PDF são removidos antes via `_strip_repeated_page_lines`)
  → embedding em lote → grava em `rag.db` (sqlite-vec). Re-ingerir a mesma fonte
  (`source_name`) substitui os chunks.
- **Busca:** pergunta → embedding → KNN por distância L2 → top-K chunks **do
  agente**. O KNN roda no store inteiro, então há over-fetch (`top_k * 3`) e filtro
  por `agent_id` antes de cortar em `RAG_TOP_K`.
- **Embeddings:** API hospedada da Jina (`jina-embeddings-v3`, 384 dim via
  Matryoshka, multilíngue, vetores L2-normalizados → distância L2 monotônica com
  cosseno). Roda fora do servidor, então o backend fica leve (sem PyTorch). Busca
  assimétrica: `retrieval.passage` na ingestão, `retrieval.query` na consulta.
- **Degradação graciosa:** se a Jina estiver indisponível, a **busca** captura o
  erro e devolve vazio (o agente responde pelo prompt base / faz handoff); a
  **ingestão** propaga `EmbeddingUnavailableError` (503 com mensagem clara).

Dois atalhos cortam custo de LLM a zero: match RAG muito forte responde o chunk
literal (`faq_shortcut`, `SHORTCUT_MAX_DISTANCE = 0.90`), e palavras de
escalonamento de suporte fazem handoff determinístico.

---

## 5. Catálogo de produtos (interno ou externo)

`app/catalog.py` abstrai a origem dos produtos por agente (`product_mode`):

- **`internal`** — tabela `products` no SQLite (via `ProductRepository`), gerenciada
  pelo painel/endpoints.
- **`external`** — o backend chama a **API REST do próprio cliente**
  (`GET product_api_url`, com `Authorization: Bearer` opcional) e espera uma
  lista JSON de produtos (`[...]` ou `{"products": [...]}`). Busca e checagem de
  estoque rodam no backend; reserva de estoque em catálogo externo gera handoff
  (a fonte da verdade é o cliente). Falha de rede degrada para lista vazia.
- **`none`** — agente sem produtos.

O agente acessa tudo isso pelas **skills de catálogo** (`app/skills/catalog.py`):
o modelo chama `check_stock`, `search_products`, `list_products`, `reserve_stock`
ou `check_catalog`, e o backend executa contra a fonte configurada. As skills
vivem no **registry** de `app/skills/` (registradas com `@skill(...)` + um modelo
Pydantic de argumentos; schema enviado ao Groq e dispatch via `invoke_skill`/
`model_validate` saem da mesma fonte — §3). O modelo nunca inventa preço ou
estoque. A skill **`check_catalog`** é nova: diagnostica o catálogo do cliente
(modo, se está configurado e — no externo — se está acessível), sem expor a
`product_api_key`.

---

## 6. Modelo de dados

`core.db` (relacional; conexão WAL, `foreign_keys = ON`):

```
tenants(id PK, name, api_key UNIQUE, created_at)
users(id PK, email UNIQUE, name, api_key UNIQUE, created_at)
memberships(tenant_id FK→tenants, user_id FK→users, role)   -- PK (tenant_id, user_id); role owner|member
agents(id PK = {tenant}__{slug}, tenant_id FK→tenants, slug, name, system_prompt,
       business_rules, max_turns, product_mode, product_api_url, product_api_key,
       rag_enabled, external_products, skills, created_at)   -- UNIQUE (tenant_id, slug)
       -- skills: TEXT com lista JSON de skills habilitadas ('[]' == derivar das flags)
products(id PK, agent_id FK→agents, name, description, price, stock, unit)
```

`rag.db` (vetorial, sqlite-vec):

```
chunks(id PK, agent_id, source_name, chunk_index, content, created_at)
chunk_embeddings(chunk_id PK, embedding FLOAT[384])   -- tabela virtual vec0
```

> A credencial subiu para o tenant: `agents` **não tem mais `api_key`**.
> `rag_enabled` e `external_products` são **feature flags** por agente (ponto 8);
> `skills` é a lista de capacidades habilitadas (vazia → derivada das flags). A
> coluna `skills` é adicionada no boot via `ALTER TABLE ... ADD COLUMN` idempotente
> (`_ensure_agent_columns`), então bancos anteriores ganham a coluna sem perder dados.
> Bancos legados são migrados no boot, de forma idempotente: `core.db` antigo
> (agente com `api_key`, sem tenant) é reconstruído no modelo multi-tenant
> (agentes vão para o tenant `default`, `api_key` por agente descartada,
> produtos/RAG preservados); em `rag.db`, `chunks.tenant_id` → `agent_id`.
> Ver `app/db.py` (`_migrate_agents_to_multitenant`) e `docs/DEBUG.md`.

---

## 7. Erros, copy e observabilidade (transversais)

- **Erros (`app/errors.py`, ponto 10):** o domínio levanta `AppError` tipado
  (`NotFoundError` 404, `ConflictError` 409, `ValidationError` 400,
  `UnauthorizedError` 401, `ForbiddenError` 403, `EmbeddingUnavailableError` 503).
  Um único `exception_handler` em `main.py` serializa `{code, detail}` com o status
  certo; um handler genérico transforma o inesperado em 500 padronizado.
  **Regra degrade-vs-propagate:** no **chat**, erros degradam para handoff 200
  (o Orchestrator captura); em **admin/config/knowledge/products**, `AppError`
  propaga com status tipado.
- **Copy (`app/messages.py`, ponto 5):** toda mensagem voltada ao usuário final
  (handoff, escalonamento, catálogo degradado, pedido confirmado) vive centralizada
  — um lugar só para ajustar e preparar i18n / override por tenant.
- **Logs correlacionados (`app/logging_ctx.py`, ponto 9):** um middleware fixa
  `request_id` (header `X-Request-ID`, gerado se ausente, devolvido na resposta) e
  `tenant` (extraído do path) em contextvars; um filtro injeta ambos em **todo**
  `LogRecord`. Nível por `LOG_LEVEL`. Logger hierárquico `blip-agent.*`. Detalhes
  operacionais e de diagnóstico em [`DEBUG.md`](DEBUG.md).

---

## 8. Concorrência e workers

- **I/O bloqueante** (SDK do Groq, HTTP da Jina, SQLite) roda em worker thread via
  `asyncio.to_thread`, para não travar o event loop do FastAPI. O SkilledAgent
  roda o loop de skills (function calling) inteiro em uma thread — e o atalho RAG
  do fast-path também; a ingestão de PDF/texto idem.
- **Fila de ingestão (`app/tasks.py`, ponto 7):** com `REDIS_URL` configurado, a
  ingestão é enfileirada (Celery) e o endpoint responde **202** (`status="queued"`);
  um worker processa em background (`celery -A app.tasks.celery_app worker`). **Sem
  broker**, cai no caminho **síncrono** (200 com `chunks_created`) — o comportamento
  padrão. O PDF trafega como bytes (base64 na fila), então o worker não depende de
  arquivo temporário do processo web.

> `celery[redis]` **não** está em `requirements.txt`: ativar a fila exige instalar
> a dependência no ambiente (ver `DEBUG.md`).

---

## 9. Estratégias de economia de tokens

| Estratégia | Onde | Efeito |
|---|---|---|
| Só as últimas 5 mensagens vão ao LLM | `orchestrator.py` (HISTORY_LIMIT) | corta o histórico que mais cresce |
| System prompts compactos | `prompts.py` | base de ~2 frases + só as regras das skills habilitadas |
| `RAG_TOP_K = 3` chunks/pergunta | `config.py` | menos contexto injetado |
| Atalho RAG sem LLM | `agents/skilled.py` + `skills/knowledge.py` | match forte → 0 tokens |
| Handoff determinístico de suporte | `agents/skilled.py` + `skills/support.py` | escalonamento → 0 tokens |

**Trade-off do novo roteamento:** o classificador por palavra-chave (0 token,
mas fonte das falhas da §10) foi **removido** — o roteamento agora é decisão do
LLM via function calling, o que custa ~1 chamada nos casos que antes ele resolvia
de graça. Os dois atalhos de 0 token acima foram **preservados** para o caminho
comum; o atalho RAG custa só um embedding (não tokens de LLM). É uma troca
deliberada de um pouco mais de custo por correção de roteamento.

Na avaliação histórica (seção 10), **4 das 12 perguntas foram respondidas com 0
tokens** e a média ficou em ~433 tokens/pergunta — números do modelo antigo (com
classificador); reexecute o harness para revalidar sob o modelo de skills.

---

## 10. Resultados de avaliação

Medidos com o FAQ real da Loja Demo (6 páginas, 10 chunks). Reproduzível via
`docs/eval_harness.py`, que **reescreve** `docs/eval_log.md` ao rodar (o log não é
versionado). Os números abaixo são do run histórico — reexecute para revalidar.

**Embeddings (Jina):**
- Dimensão 384, vetores L2-normalizados (norma média 1.0000) — OK.
- Matriz pergunta × tópico: **acerto top-1 de 5/5 (100%)** com folga (diagonal
  0.55–0.81 vs. ruído < 0.41). A recuperação semântica está sólida.

**Chat (12 perguntas com gabarito):**
- Acurácia factual: **8/12 (67%)** · ~433 tokens/pergunta · 852 ms média.
- **As 4 falhas não são de RAG — são de roteamento.** Forçando essas mesmas 4
  perguntas pela skill `knowledge_search` (bateria 4 do harness), obtém-se **4/4
  corretas** — daí a remoção do classificador.

**Por que falhou:** o classificador por palavra-chave desvia perguntas que são
de FAQ para os agentes errados, que não consultam a base de conhecimento:

| Pergunta | Palavra que desviou | Foi para | Resultado |
|---|---|---|---|
| "quanto tempo **demora** a entrega…" | demora | support | inventou "3 a 5 dias" (real: 2 a 4) |
| "quanto **custa** a entrega expressa?" | custa | order | handoff (resposta estava no FAQ) |
| "quanto **custa** a garantia estendida?" | custa | order | handoff (R$ 49,90 estava no FAQ) |
| "posso **cancelar** meu pedido…" | cancelar | support | handoff automático |

**Conclusão (histórica):** embeddings e RAG estavam prontos; o gargalo de
qualidade era o classificador de intenção. **Este refactor o removeu** — o
roteamento passou a ser decisão do LLM via skills (function calling), com a
pergunta inteira em contexto, então o desvio por palavra-chave deixou de existir
(o diagnóstico continua reproduzível na bateria 4 do harness). Reexecute
`docs/eval_harness.py` para medir a acurácia sob o modelo de skills.

---

## 11. Limitações conhecidas e melhorias

**Prioridade alta**
1. **Classificador de intenção — RESOLVIDO neste refactor.** Era o item de maior
   impacto: palavras como "custa"/"demora"/"cancelar" sequestravam perguntas de
   FAQ. Adotou-se a opção (c) — **o LLM decide a skill** via function calling
   (`SkilledAgent`), e o classificador por palavra-chave foi removido. O que
   resta é medir a acurácia sob o novo modelo (reexecutar o harness) e ajustar as
   descrições das skills se o modelo escolher mal em algum caso.
2. **Anti-alucinação de catálogo.** Manter a disciplina de só afirmar
   disponibilidade/preço com base nas skills de catálogo (nunca "de cabeça"). O
   prompt já instrui isso e `check_catalog`/`check_stock` dão o caminho de
   verificação; vale um teste dedicado ("vocês vendem geladeira?" não deve virar
   "sim, vendemos" sem consultar).

**Prioridade média**
3. **Segurança de LLM / prompt injection.** `system_prompt` e `business_rules` são
   editáveis pelo cliente e concatenados direto no prompt (`prompts.py`); o conteúdo
   RAG também é injetado. Antes de expor amplamente, definir sanitização/limites e
   proteção contra injeção/jailbreak e contra documentos envenenados.
4. **SSRF no catálogo externo.** `product_api_url` é fornecida pelo owner e o
   backend faz `GET` nela (`catalog._fetch_external`) — pode alcançar serviços
   internos. Validar/allowlist de host antes de tratar owners como semiconfiáveis.
5. **Observabilidade de negócio.** Os tokens já voltam por resposta, mas não são
   persistidos. Para faturar/monitorar por cliente: registrar tokens, nº de chamadas
   à IA, taxa de handoff e latência por agente.

**Prioridade a planejar**
6. **Escala e segurança do backend.** Rate limiting por agente/tenant, rotação de
   chaves, CORS restrito (hoje `allow_origins=["*"]`), e SQLite → Postgres se a
   concorrência de escrita crescer (hoje é arquivo único, atenuado por WAL).
7. **Sincronia do catálogo externo.** Cada consulta bate na API do cliente; um
   cache curto com invalidação reduziria latência e carga.
8. **Backing das skills (serverless / AWS Lambda).** As skills hoje são
   `LocalSkill` (in-process). A interface (`SkillContext`/`SkillResult`
   serializáveis, args Pydantic) já é remoteável: uma `RemoteSkill` poderia rodar
   cada skill como uma Lambda/serviço HTTP, isolando custo, deploy e escala por
   capacidade. **Decisão consciente de adiar:** mantém-se tudo em código no
   protótipo; migrar exige definir empacotamento, latência (cold start), auth de
   invocação e observabilidade distribuída. Migrar uma skill não mexe no registry
   nem no agente — só no transporte. **Desenho detalhado** (decisão por decisão,
   contrato de fio, segurança, passos de implementação): [`SKILLS_REMOTAS.md`](SKILLS_REMOTAS.md).

---

## 12. Como rodar e reproduzir

```bash
# Local
python -m venv .venv
.venv/Scripts/activate                 # Windows
pip install -r requirements.txt
cp .env.example .env                    # preencha GROQ_API_KEY, JINA_API_KEY, ADMIN_API_KEY
uvicorn server:app --reload --port 8000 # painel em http://localhost:8000

# Avaliação (com GROQ_API_KEY e JINA_API_KEY no .env)
PYTHONPATH=. .venv/Scripts/python.exe docs/eval_harness.py
# → escreve docs/eval_log.md (usa banco temporário, não toca os dados reais)
```

No primeiro boot é criado o tenant `default` e um agente `demo` (desligue com
`SEED_DEMO=0`). Em produção (Railway), aponte `DB_DIR` para um Volume montado
(ex.: `/app/data`), senão os bancos são recriados a cada deploy. A lista completa
de variáveis de ambiente está em `app/config.py` e no `.env.example`.
