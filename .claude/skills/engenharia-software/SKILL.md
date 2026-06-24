---
name: engenharia-software
description: >-
  Guia de engenharia de software e organização do projeto blip-agent (Next.js +
  TypeScript). Use para decisões de arquitetura, refatoração, onde colocar código
  novo, manutenção de convenções, revisão de estrutura, invariantes do projeto e o
  grafo de dependências entre camadas. Invoque antes de criar módulos/pastas novas,
  ao refatorar, ao revisar PRs do ponto de vista estrutural, ou quando estiver em
  dúvida sobre "onde isso deveria morar".
---

# Engenharia de software & organização — blip-agent

Como o projeto está organizado, **por que** está assim e como estender sem corroer
a arquitetura. Visão atual em `docs/ARQUITETURA.md`. (Stack migrado de FastAPI/Python
para Next.js/TypeScript preservando as camadas e os contratos da API.)

## Princípio central: camadas com dependência unidirecional

```
route.ts  →  services  →  repositories  →  domain
(HTTP)       (negócio)     (Drizzle)        (tipos)
   │             │              │
   └─ schemas    └─ errors,     └─ db (infra: client/schema/ddl/bootstrap)
      (Zod)         messages
```

Regra: cada camada só conhece as **de baixo**. Um módulo de baixo nunca importa um
de cima. Isso mantém o acesso a dados isolado nos repositórios e as rotas finas.

## Onde isso deveria morar? (árvore de decisão)

- É **acesso a dado (Drizzle)**? → `src/server/repositories/<dominio>.ts`. Em lugar nenhum mais.
- É **regra de negócio / validação / orquestração**? → `src/server/services/<dominio>.ts`.
- É **forma de request/response da API**? → `src/server/schemas.ts` (Zod + mapeador `to*`).
- É um **tipo interno** que cruza camadas? → `src/server/domain.ts`.
- É **texto mostrado ao usuário final**? → `src/server/messages.ts` (nunca inline).
- É um **erro de domínio**? → subclasse de `AppError` em `src/server/errors.ts`.
- É **infra de banco** (conexão, schema, DDL, seed)? → `src/server/db/*`.
- É **serialização wire (snake_case) ou auth**? → `src/server/http/serialize.ts` / `http/auth.ts`.
- É uma **capacidade nova do agente**? → uma **skill** em `src/server/skills/<dominio>.ts`
  (registre em `skills/index.ts`). Caminho padrão — ver skill `backend`.
- É um **fluxo de conversa realmente novo** (raro)? → só então um agente em
  `src/server/agents/`. Quase tudo é skill: há **um** agente flexível (`SkilledAgent`) + fallback.

## Invariantes que não podem quebrar

1. **Isolamento multi-tenant é da camada de dados.** Todo método de repositório de
   produto/RAG recebe `agentId` e filtra por ele; agentes/membros filtram por `tenantId`.
   Garantia da classe, não disciplina do chamador.
2. **`AgentResult` (agente) ≠ `ProcessResult`/`ChatResponse` (API).** `intent`/`agentUsed`/
   `confidence` são do Orchestrator; `chatResponse()` serializa para o fio.
3. **Tipos, não dicts opacos.** Contratos internos são interfaces em `domain.ts`.
4. **Fonte única de verdade.** Skills: schema (function calling) e dispatch saem do mesmo
   registry (`skills/base.ts`). DDL de tabela: `db/ddl.ts` cria, `db/schema.ts` consulta —
   **mantenha os dois em sincronia** ao alterar uma tabela.
5. **camelCase interno, snake_case no fio.** Conversão só na fronteira (`schemas.ts` na
   entrada, `http/serialize.ts` na saída). Segredos (`product_api_key`) nunca em resposta.
6. **Idempotência no boot.** `db:setup` (extensão + DDL + seed) pode rodar N vezes.

## Padrões positivos a preservar

- `BaseAgent` é classe abstrata; o contrato `execute`/`systemPrompt` padroniza os agentes.
- **Skills como unidade de extensão.** `Skill` + registry + `registerLocal`: a capacidade
  cresce, não o agente. O contrato `(ctx, args) → SkillResult` é serializável de propósito
  (fronteira pronta para Lambda). Não acople skill a I/O do agente.
- **Logger hierárquico** `blip-agent.*`, correlacionado por `req`/`tenant` (AsyncLocalStorage).
- Services **stateless** como singletons + getters `getXService`.
- **I/O assíncrono nativo** (`async/await`); não reintroduza worker threads (era do Python).
- Inicialização **lazy** do banco (`db/client.ts` via Proxy) — não conecta em build.

## Convenções de código

- TypeScript **strict**. pt-BR em comentários, focados no **porquê**.
- Logger por módulo: `getLogger("blip-agent.<modulo>")`.
- Imports: `@/` (alias para `src/`) nas rotas/componentes; relativos dentro de `src/server/**`.
- Whitelist de campos editáveis em update (ex.: `EDITABLE` em produtos) — nunca aceite
  chaves arbitrárias num `set`.
- Nomes de tenant/agente vêm de `slugify` (ASCII estável); `id` de agente é
  `{tenant}__{slug}` (PK opaca, resolve colisão de slug entre tenants).

## Validação / testes

Não há suíte de unit tests formal ainda. A validação hoje é:
- **Estático:** `npm run typecheck` (tsc) + `npm run build`.
- **Smoke manual:** `db:setup` + `npm run dev`, então `/health`, criar tenant/agente,
  exercitar chat (fast-paths de 0 token, catálogo, escalonamento), ingestão e isolamento
  (chave de um tenant em agente de outro → 403; agente inexistente → 404).

Ao adicionar lógica não-trivial, rode ao menos `typecheck` antes de concluir. (O antigo
`docs/eval_harness.py` foi removido na migração; reescrita em TS é trabalho futuro.)

## Manter a documentação em sincronia

Mexeu na arquitetura? Atualize **`docs/ARQUITETURA.md`**. Mexeu em operação/logs/banco?
**`docs/DEBUG.md`**. Mexeu em como rodar/deploy? **`README.md`** e os skills `backend`/`devops`.

## Dívida técnica conhecida

Lista em `docs/ARQUITETURA.md` §11. De maior impacto: anti-alucinação de catálogo,
itens de segurança (ver skill `seguranca`), backing das skills (serverless/Lambda) e —
quando a concorrência crescer — índice ANN no pgvector (HNSW) e fila assíncrona de
ingestão sem Redis (pg-boss). Trate como roadmap, não bugs soltos.
