# Arquitetura — blip-agent

Plataforma multi-tenant de agentes de atendimento. Um **tenant** (cliente) é dono
de **N agentes**; cada agente tem endpoint de chat próprio, base de conhecimento
(RAG) própria, regras de negócio editáveis e catálogo de produtos opcional. A
proposta é funcionar como um "mini Blip Studio": o cliente configura agentes pela
interface/API e os consome via endpoints REST, sem um time interno dedicado a
cada bot.

Usuários se vinculam a um tenant por uma **membership** com papel (`owner`/
`member`) — RBAC mínimo. A credencial de consumo vive no nível do **tenant**.

- **Stack:** Next.js 15 (App Router) · TypeScript · Anthropic Claude (LLM) · Jina (embeddings) · **Postgres + pgvector** (dados e vetores no mesmo engine) · Drizzle ORM
- **Deploy:** Railway (NIXPACKS), `next build` / `next start`; estado no Postgres (sem SQLite, sem Volume). No deploy roda `npm run db:setup` (extensão pgvector + schema + seed, idempotente)
- **Front-end:** painel admin React (`src/app/page.tsx`) servido pela própria app em `/` (usa a `ADMIN_API_KEY` como superusuário)
- **Camadas:** rotas (HTTP) → services (regra de negócio) → repositories (Drizzle) → domínio tipado
- **Ingestão:** **síncrona** no request (Celery/Redis removidos na migração para TS)

> Migrado de FastAPI/Python para Next.js/TypeScript preservando URLs e contratos da
> API. **Este documento e o código são a fonte de verdade.**

---

## 1. Visão de componentes

```
                          ┌─────────────────────────────┐
   Navegador / cliente    │ src/app/page.tsx (painel)    │
   (painel admin ou       │ + src/app/dashboard (dados)  │
    integração)           └──────────────┬──────────────┘
                                         │ HTTPS (REST + X-Admin-Key / X-API-Key)
                          ┌──────────────▼──────────────┐
                          │     Next.js (App Router)     │  src/app/v1/**/route.ts
                          │  wrapper: req_id + log + erro │  http/route.ts (X-Request-ID)
                          │  AppError → status tipado     │  http/auth.ts (RBAC)
                          │  ┌────────────────────────┐  │
                          │  │ rotas v1/tenants/...   │  │  RBAC: admin /
                          │  │  tenants · agents · chat│  │  owner / member
                          │  │  knowledge · products  │  │
                          │  └───────────┬────────────┘  │
                          │     services/ → repositories/ │  regra de negócio → SQL
                          │              ▼               │
                          │       Orchestrator           │  prepara o contexto e
                          │   (instância por request)    │  delega ao agente
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
                          │  rag.ts  │ │llm.ts│ │catalog. │
                          │ pgvector │ │Claude│ │ ts      │
                          │ (Chunk-  │ └──┬───┘ └────┬────┘
                          │  Repo)   │    │          │
                          └────┬─────┘    │     ┌────┴─────┐
                               │      Anthropic  │ interno  │ Postgres
                       embeddings  │    API      │   OU     │
                        (Jina API)─┘             │ externo  │ API REST do cliente
                                                └──────────┘
```

Mapa de arquivos:

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Config | `src/server/config.ts` | Env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, modelos, DATABASE_URL, LOG_LEVEL) |
| API | `src/app/v1/**/route.ts`, `src/server/http/*` | Endpoints, RBAC (`auth.ts`), wrapper (`route.ts`: log+erros+X-Request-ID), serializadores, `/health` |
| Domínio | `src/server/domain.ts` | Tipos (Tenant, User, Membership, Principal, AgentConfig, ProductRow, AgentResult, ChatMessage) |
| Schemas | `src/server/schemas.ts` | Validação Zod por domínio + mapeadores wire→DTO |
| Services | `src/server/services/*` | Regra de negócio (Agent/Tenant/Product/Knowledge) |
| Dados | `src/server/repositories/*`, `src/server/db/*` | Acesso via Drizzle + schema/DDL + bootstrap (seed) |
| Erros / Copy | `src/server/errors.ts`, `messages.ts` | Hierarquia única de `AppError`; copy pt-BR voltada ao usuário |
| Orquestração | `src/server/orchestrator.ts` | Trunca histórico, aplica limite de turnos (→ fallback) e delega ao agente flexível |
| Agentes | `src/server/agents/*` | Agente flexível (`SkilledAgent`, dirigido por skills) + fallback estático |
| Skills | `src/server/skills/*` | Capacidades discretas invocadas via function calling; interface pronta para virar Lambda |
| Prompts | `src/server/prompts.ts` | System prompts compactos (base + regras só das skills habilitadas) |
| RAG | `src/server/rag.ts`, `embeddings.ts`, `repositories/chunks.ts` | Chunking + orquestração de embeddings (`rag.ts`); toda query da tabela `chunks` (ingestão, KNN pgvector, fontes) vive na `ChunkRepository` |
| Catálogo | `src/server/catalog.ts` | Produtos (Postgres interno OU API externa) + health check do catálogo |
| Observabilidade | `src/server/logging.ts` | Correlação de log por `requestId` + `tenant` (AsyncLocalStorage) |
| Texto | `src/server/textutil.ts` | Normalização/tokenização (`normalize`, `wordSet`, `slugify`) |

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

# Apoio aos times (UX e dados)
GET    /v1/tenants/{tid}/skills                       (member) catálogo de skills + descrições (UX)
POST   /v1/tenants/{tid}/assist/agent-config          (owner)  IA rascunha system_prompt + regras (UX)
GET    /v1/tenants/{tid}/analytics?days=&agent=       (member) dashboard: transbordo/sucesso/tokens/logs (dados)

# Operacional
GET    /health                                        (público) status, modelo, celery on/off, tenants
GET    /                                              (público) serve o painel admin (client.html)
GET    /dashboard                                     (público) painel do time de dados (dados via X-API-Key)
```

**Autenticação + RBAC** (`src/server/http/auth.ts`, ponto 8). Uma só função
`resolvePrincipal` produz um `Principal` tipado (`role` ∈ admin/owner/member):

- `X-Admin-Key` = `ADMIN_API_KEY` — admin de **plataforma** (cria/exclui tenants; superusuário em qualquer tenant).
- `X-API-Key` = api_key do **tenant** — `owner` do próprio tenant (chave master/consumo).
- `X-API-Key` = api_key de **usuário** — papel vindo da membership (`owner` | `member`).

Guards reutilizáveis: `requirePlatformAdmin`, `requireOwner`,
`requireMember`. `member` tem leitura + chat + conteúdo (knowledge/produtos);
`owner`/`admin` gerenciam agentes e membros (`canManage`).

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
| **create_ticket** | support | **(nova)** Abre um chamado (nome/e-mail do usuário obrigatórios; IA classifica a criticidade) e grava na tabela `tickets` | dado JSON |

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

`src/server/rag.ts` + `src/server/embeddings.ts` orquestram; toda persistência
(tabela `chunks`) fica na `ChunkRepository` (`repositories/chunks.ts`):

- **Ingestão:** PDF/texto → chunking por seção (um tópico por chunk; cabeçalhos
  e rodapés repetidos de PDF são removidos antes via `stripRepeatedPageLines`)
  → embedding em lote → grava via `ChunkRepository.replaceSource` (Postgres +
  pgvector). Re-ingerir a mesma fonte (`source_name`) substitui os chunks
  (delete + insert atômicos na mesma transação).
- **Busca:** pergunta → embedding → KNN por distância L2 (operador `<->` do
  pgvector) → top-K chunks **do agente**. O filtro `WHERE agent_id = ?` entra na
  própria query e o `ORDER BY` usa a distância direto — sem o over-fetch `x3` que
  o antigo sqlite-vec exigia; o corte em `RAG_TOP_K` é o `LIMIT`.
- **Embeddings:** API hospedada da Jina (`jina-embeddings-v3`, 384 dim via
  Matryoshka, multilíngue, vetores L2-normalizados → distância L2 monotônica com
  cosseno). Roda fora do servidor, então o backend fica leve (sem PyTorch). Busca
  assimétrica: `retrieval.passage` na ingestão, `retrieval.query` na consulta.
- **Degradação graciosa:** se a Jina estiver indisponível, a **busca** captura o
  erro e devolve vazio (o agente responde pelo prompt base / faz handoff); a
  **ingestão** propaga `EmbeddingUnavailableError` (503 com mensagem clara).

Um atalho corta custo de LLM a zero: palavras de escalonamento de suporte fazem
handoff determinístico (`ESCALATION_KEYWORDS`). Matches RAG passam pelo loop normal
do `SkilledAgent` para que o LLM formate a resposta com base no chunk encontrado.

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
Pydantic de argumentos; schema enviado ao LLM e dispatch via `invoke_skill`/
`model_validate` saem da mesma fonte — §3). O modelo nunca inventa preço ou
estoque. A skill **`check_catalog`** é nova: diagnostica o catálogo do cliente
(modo, se está configurado e — no externo — se está acessível), sem expor a
`product_api_key`.

---

## 6. Modelo de dados

Tudo num único **Postgres** (antes eram `core.db` relacional e `rag.db` vetorial).

Relacional:

```
tenants(id PK, name, api_key UNIQUE, created_at)
users(id PK, email UNIQUE, name, api_key UNIQUE, created_at)
memberships(tenant_id FK→tenants, user_id FK→users, role)   -- PK (tenant_id, user_id); role owner|member
agents(id PK = {tenant}__{slug}, tenant_id FK→tenants, slug, name, system_prompt,
       business_rules, max_turns, product_mode, product_api_url, product_api_key,
       rag_enabled, external_products, skills, created_at)   -- UNIQUE (tenant_id, slug)
       -- skills: TEXT com lista JSON de skills habilitadas ('[]' == derivar das flags)
products(id PK, agent_id FK→agents, name, description, price, stock, unit)
tickets(id PK, agent_id FK→agents, title, description, user_name, user_email, criticality, created_at)
interactions(id PK, agent_id FK→agents, tenant_id, intent, source, agent_used,
       tokens_used, should_handoff, handoff_reason, tools_called JSONB,
       rag_chunks_used, confidence, created_at)   -- 1 linha/mensagem; telemetria do dashboard, SEM PII
```

Vetorial (pgvector, mesma instância):

```
chunks(id PK, agent_id, source_name, chunk_index, content, embedding vector(384), created_at)
```

> A credencial vive no tenant: `agents` **não tem `api_key`**. `rag_enabled` e
> `external_products` são **feature flags** por agente; `skills` é a lista de
> capacidades habilitadas (vazia → derivada das flags). A busca KNN filtra por
> `agent_id` no `WHERE` (operador `<->` do pgvector), sem o over-fetch que o
> sqlite-vec exigia. O schema é criado no boot por `scripts/setup-db.ts`
> (`CREATE EXTENSION vector` + DDL idempotente em `src/server/db/ddl.ts`) — fonte
> de verdade da criação de tabelas; `src/server/db/schema.ts` (Drizzle) é a fonte
> das queries tipadas. Em produção (Supabase) quem cria as tabelas é
> `supabase/schema.sql` (rodado uma vez no SQL Editor) — os **três** artefatos
> (`ddl.ts`, `schema.ts`, `supabase/schema.sql`) descrevem as mesmas colunas e devem
> ser mantidos em sincronia. **Greenfield:** sem migração de bancos legados.

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
- **Telemetria de interações (time de dados):** além dos logs de console, cada
  mensagem do chat grava uma linha em `interactions` (best-effort: uma falha de
  gravação nunca derruba o chat). É a fonte do dashboard em `/dashboard` e da rota
  `GET .../analytics` (% de transbordo, sucesso sem transbordo, tokens, intents,
  skills, série por dia, logs recentes). **Sem PII** — só metadados. O assistente de
  IA do time de UX (`POST .../assist/agent-config`) e o catálogo de skills
  (`GET .../skills`) completam o apoio aos times. Guia por time em
  [`CONFIG_AGENTE.md`](CONFIG_AGENTE.md).

---

## 8. Concorrência e workers

- **I/O assíncrono nativo:** Anthropic, Jina e Postgres são acessados via `await` (SDK
  async / `fetch` / postgres.js). Não há `asyncio.to_thread` nem worker threads — o
  event loop do Node já não bloqueia. O `SkilledAgent` roda o loop de function
  calling inteiro com `async/await`.
- **Ingestão síncrona:** extração + embeddings + escrita rodam no próprio request e
  respondem **200** com `chunks_created`. Celery e Redis foram **removidos** na
  migração para TS.

> Ponto de extensão para fila assíncrona sem Redis (ex.: pg-boss sobre o mesmo
> Postgres) fica isolado em `services/knowledge.ts`. O limite de escrita concorrente
> passa a ser o do Postgres (bem acima do antigo arquivo SQLite único).

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
# Postgres com pgvector (Docker)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16

# App
npm install
cp .env.example .env          # preencha DATABASE_URL, ANTHROPIC_API_KEY, JINA_API_KEY, ADMIN_API_KEY
npm run db:setup              # extensão pgvector + schema + seed (demo)
npm run dev                   # painel em http://localhost:3000
```

No `db:setup` é criado o tenant `default` e um agente `demo` (desligue com
`SEED_DEMO=0`). Em produção (Railway), provisione um Postgres com pgvector e exponha
`DATABASE_URL`; o deploy roda `db:setup` automaticamente. A lista completa de
variáveis está em `src/server/config.ts` e no `.env.example`. (O antigo
`docs/eval_harness.py` foi removido na migração; a reescrita do harness em TS fica
como trabalho futuro.)
