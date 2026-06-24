---
name: backend
description: >-
  Playbook de backend do blip-agent (Next.js + TypeScript + Groq + RAG). Use ao
  adicionar ou alterar rotas, skills (capacidades do agente), o agente flexível,
  orquestração, RAG, catálogo, integração com LLM ou acesso a dados (Drizzle/Postgres).
  Cobre as camadas (route → services → repositories → domínio), o fluxo de chat por
  skills, contratos tipados (Zod), e tratamento de erros. Invoque ao mexer em qualquer
  coisa sob src/server/ ou src/app/v1/.
---

# Backend — blip-agent

Backend multi-tenant de agentes de atendimento. **Next.js (App Router)** + **TypeScript**
+ **Groq** (LLM) + **RAG** (pgvector + embeddings Jina) + **Postgres** (Drizzle ORM).
Visão completa em `docs/ARQUITETURA.md`; este skill é o **como fazer** no dia a dia.

## A regra de ouro: 4 camadas, dependência só "para baixo"

```
src/app/v1/**/route.ts  → só HTTP (validação Zod, RBAC, status). SEM regra de negócio, SEM acesso a dados.
src/server/services/    → regra de negócio. Levanta AppError. Orquestra repositories/catalog/rag.
src/server/repositories/→ TODO o acesso a dados (Drizzle). Único lugar que toca o banco. Retorna tipos de domínio.
src/server/domain.ts    → tipos (AgentConfig, ProductRow, AgentResult, Principal, ...). Sem I/O.
```

Violações que **nunca** devem entrar:
- Query Drizzle/SQL fora de `src/server/repositories/*` (nem em service, nem em rota).
- Regra de negócio dentro de um `route.ts`.
- `Response` com status cru numa rota — levante um `AppError` (§Erros); o wrapper serializa.

## Convenção camelCase interno / snake_case no fio

Internamente tudo é **camelCase** (idiomático TS). O contrato HTTP é **snake_case**.
A conversão acontece SÓ na fronteira: `src/server/schemas.ts` (Zod + mapeadores `to*`
na entrada) e `src/server/http/serialize.ts` (na saída). Segredos (`product_api_key`)
**nunca** entram numa resposta (ver `agentPublic`).

## Recurso novo de ponta a ponta

1. **Schema Zod** (`src/server/schemas.ts`): `xCreateSchema`/`xUpdateSchema` (snake_case)
   + mapeador `toX` para o DTO camelCase do service.
2. **Repository** (`src/server/repositories/<dominio>.ts`): queries Drizzle. Toda query
   escopada por tenant/agente (`where(eq(agentId, ...))`) — invariante de isolamento.
3. **Service** (`src/server/services/<dominio>.ts`): regra de negócio + validação; levanta
   `AppError`. Exponha um singleton + getter `getXService` em `services/index.ts`.
4. **Rota** (`src/app/v1/.../route.ts`): use o wrapper `route()`, faça auth via
   `requireMember/requireOwner/requirePlatformAdmin` (`http/auth.ts`), valide o corpo com
   `parseBody(req, schema)`, serialize a saída com `http/serialize.ts`.

Endpoints de agente sob `/v1/tenants/{tenantId}/agents/{slug}/...`. As URLs e contratos
foram **preservados** da versão FastAPI.

## O agente flexível (SkilledAgent) + skills

Um **único** agente de conversa, o `SkilledAgent` (`src/server/agents/skilled.ts`):
recebe as skills habilitadas e deixa o **LLM decidir qual chamar** (function calling).
Há o `FallbackAgent` estático (limite de turnos / erro). Para mudar o comportamento de
conversa, em quase todos os casos você **adiciona ou ajusta uma skill**.

## Adicionar uma skill

Schema (function calling) e implementação saem da **mesma fonte** (o registry em
`src/server/skills/base.ts`):

```ts
// src/server/skills/<dominio>.ts
import { z } from "zod";
import { CATEGORY_CATALOG, registerLocal, SkillResult } from "./base";

const minhaArgs = z.object({ campo: z.string() });

registerLocal("minha_skill", "Descrição que o modelo lê para decidir chamar.",
  minhaArgs, async (ctx, args) => {
    const dados = await algumModulo.algo(ctx.agent, args.campo);
    return new SkillResult({ data: dados });   // data = JSON devolvido ao LLM
  }, CATEGORY_CATALOG);
```

Passos:
1. Implemente no submódulo certo (`knowledge`/`catalog`/`support`) e **importe-o em
   `src/server/skills/index.ts`** — é esse import que roda o `registerLocal` e popula o REGISTRY.
2. Escolha a `category` (`CATEGORY_KNOWLEDGE`/`CATALOG`/`SUPPORT`/`GENERAL`): deriva a
   skill das flags em `enabledSkillsFor` quando o agente não declara skills explícitas.
3. Sinais no `SkillResult`: `handoff`/`handoffReason`; `directResponse` (resposta pronta →
   skill terminal, encerra o turno, como `escalate_to_human`); `sources` (proveniência RAG).
4. Schema e dispatch derivam do registry (`toolSchemasFor`/`invokeSkill`). O schema vem do
   args Zod via `zod-to-json-schema`. Retries para `tool_use_failed` em `llm.ts`.
5. Valide nomes no serviço: `AgentService.checkSkills` rejeita skill fora do registry (400).

**Skill remota (futuro, AWS Lambda):** o contrato é serializável de propósito. Crie uma
classe que implemente `Skill` cujo `invoke` chame o backend remoto; registre com `register`.
Registry, agente e schema não mudam — só o transporte. Hoje tudo é `LocalSkill`.

## Async (importante)

Tudo é **async nativo** em Node: Groq (SDK async), Jina (`fetch`) e Postgres (postgres.js)
são acessados com `await`. **Não** há `asyncio.to_thread` nem worker threads (era do Python).
As skills podem ser `async`; o agente as aguarda no loop.

## Contratos tipados

- `AgentResult` = saída do **agente**. `ProcessResult` (orchestrator) injeta
  `intent`/`agentUsed`/`confidence`. `chatResponse()` serializa para o contrato da API.
- `SkillResult` = saída de uma **skill** (`data` JSON + sinais). Serializável (fronteira p/ Lambda).
- `ProductRow` tem o **mesmo shape** para catálogo interno e externo (`productRowFromExternal`).
- `AgentConfig` é um objeto comum (sem `frozen`/cache): o Orchestrator é instanciado por
  request; o `LLMClient` é singleton (`getLlm`).

## Erros (degrade vs. propagate)

Levante `AppError` tipado de `src/server/errors.ts` (`NotFoundError` 404, `ConflictError`
409, `ValidationError` 400, `UnauthorizedError` 401, `ForbiddenError` 403,
`EmbeddingUnavailableError` 503). O wrapper `http/route.ts` serializa `{code, detail}`.

- **No chat**, qualquer erro **degrada** para handoff 200 (o `try/catch` do Orchestrator).
  O detalhe vai **só para o log** — nunca para o usuário.
- **Em admin/config/knowledge/products**, o `AppError` **propaga** com status tipado.

Mensagens ao usuário final ficam em `src/server/messages.ts`.

## Economia de tokens (não regrida)

`HISTORY_LIMIT=5`, prompts compactos (`prompts.ts`), `RAG_TOP_K=3`, atalho RAG sem LLM
(`SHORTCUT_MAX_DISTANCE=0.90`) e escalonamento determinístico (`ESCALATION_KEYWORDS`),
ambos no `SkilledAgent`. Os dois atalhos de 0 token são invariantes.

## RAG / pgvector

Busca em `src/server/rag.ts`: filtra por `agent_id` no `WHERE` e ordena por distância L2
(`l2Distance` / operador `<->`) — sem o over-fetch que o sqlite-vec exigia. Ingestão:
chunking por seção → embeddings Jina em lote → grava `chunks`. Re-ingerir o mesmo
`source_name` substitui os chunks.

## Onde mexer (atalho)

| Quero… | Vá em |
|---|---|
| nova capacidade do agente | `src/server/skills/<dominio>.ts` (+ registrar em `skills/index.ts`) |
| comportamento de conversa / prompt | a skill certa + `prompts.ts::skilledPrompt` |
| como o agente roda as skills | `agents/skilled.ts` (fast-paths + loop) |
| quais skills um agente tem | `skills/base.ts::enabledSkillsFor` |
| chunking/busca RAG | `rag.ts` (+ `embeddings.ts`) |
| novo campo de config do agente | `db/schema.ts` + `db/ddl.ts` (os dois!), `domain.ts`, `schemas.ts`, `repositories/agents.ts` |
| nova credencial/papel | `http/auth.ts`, `domain.ts::Principal` (e ver o skill `seguranca`) |

Antes de finalizar: `npm run typecheck` e atualize `docs/ARQUITETURA.md` se a arquitetura mudou.
