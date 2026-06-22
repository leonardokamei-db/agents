---
name: engenharia-software
description: >-
  Guia de engenharia de software e organização do projeto blip-agent. Use para
  decisões de arquitetura, refatoração, onde colocar código novo, manutenção de
  convenções, revisão de estrutura, invariantes do projeto e o grafo de
  dependências entre camadas. Invoque antes de criar módulos/pastas novas, ao
  refatorar, ao revisar PRs do ponto de vista estrutural, ou quando estiver em
  dúvida sobre "onde isso deveria morar".
---

# Engenharia de software & organização — blip-agent

Como o projeto está organizado, **por que** está assim e como estender sem corroer
a arquitetura. O histórico de decisões está em `docs/REVISAO_ARQUITETURA.md`
(análise de 19 pontos, 11 fases concluídas); a visão atual em `docs/ARQUITETURA.md`.

## Princípio central: camadas com dependência unidirecional

```
routers  →  services  →  repositories  →  domain
(HTTP)      (negócio)     (SQL)            (tipos)
   │            │             │
   └─ schemas   └─ errors,    └─ db (infra: conexão/transação/migração)
      (Pydantic)   messages
```

Regra: cada camada só conhece as **de baixo**. Um módulo de baixo nunca importa um
de cima. Isso mantém o SQL isolado (troca de SQLite→Postgres fica local aos
repositórios) e os routers finos (fáceis de testar e de versionar a API).

## Onde isso deveria morar? (árvore de decisão)

- É **SQL / acesso a dado**? → `app/repositories/<dominio>.py`. Em lugar nenhum mais.
- É **regra de negócio / validação / orquestração**? → `app/services/<dominio>.py`.
- É **forma de request/response da API**? → `app/schemas/<dominio>.py`.
- É um **tipo de dado interno** que cruza camadas? → `app/domain.py` (dataclass).
- É **texto mostrado ao usuário final**? → `app/messages.py` (nunca inline).
- É um **erro de domínio**? → subclasse de `AppError` em `app/errors.py`.
- É **infra de banco** (conexão, schema, migração)? → `app/db.py` / `rag.py`.
- É **helper de string**? → `app/textutil.py`.
- É uma **capacidade nova do agente** (buscar algo, consultar, agir)? → uma
  **skill** em `app/skills/<dominio>.py` (registre em `skills/__init__.py`). É o
  caminho padrão — ver skill `backend`.
- É um **fluxo de conversa realmente novo** (raro)? → só então um agente em
  `app/agents/`. Quase tudo é skill, não agente: há **um** agente flexível
  (`SkilledAgent`) + o fallback estático.

Um **módulo por domínio** em `schemas/`, `services/`, `repositories/`, espelhando os
routers. Os `__init__.py` reexportam para manter imports curtos
(`from app.schemas import X`) e documentam o pacote.

## Invariantes que não podem quebrar

1. **Isolamento multi-tenant é da camada de dados.** Todo método de repositório de
   produto/RAG recebe `agent_id` e aplica `WHERE agent_id = ?`; agentes/membros
   filtram por `tenant_id`. Não é "disciplina do chamador" — é garantia da classe.
2. **`AgentResult` (saída do agente) ≠ `ChatResponse` (API).** Não funda os dois:
   `intent`/`agent_used`/`confidence` são do Orchestrator. (Erro clássico evitado:
   ver C1 em `REVISAO_ARQUITETURA.md`.)
3. **Tipos, não dicts opacos.** Contratos internos são dataclasses em `domain.py`,
   não `dict` com magic strings. `from_row`/`from_external` centralizam a desserialização.
4. **Fonte única de verdade.** Skills: schema (function calling) e dispatch saem do
   mesmo registry (`app/skills/`, decorator `@skill`). DDL de `agents`: uma função
   (`_agents_ddl`) serve schema e migração. `ProductMode` vive em `domain.py` e é
   reexportado pelos schemas.
5. **Segredos não aparecem em schema de resposta** (ver `seguranca`).
6. **Idempotência no boot.** Migrações em `init_db`/`init_rag_db` podem rodar N vezes.

## Padrões positivos a preservar (não "refatore para fora")

- `BaseAgent` é **ABC** com `@abstractmethod` — o contrato `execute`/`system_prompt`
  padroniza os agentes (`SkilledAgent`, `FallbackAgent`).
- Padrão **use-case `execute()`** idêntico em toda subclasse de agente.
- **Skills como unidade de extensão.** `Skill` (ABC) + registry + `@skill`: a
  capacidade é a peça que cresce, não o agente. O contrato `(ctx, args) →
  SkillResult` é serializável de propósito — fronteira pronta para virar Lambda
  sem mexer no registry nem no agente. Preserve isso (não acople skill a I/O do agente).
- **Logger hierárquico** `blip-agent.*`, enriquecido com correlação `req`/`tenant`.
- Services **stateless** expostos como singletons + getters `get_*_service` (injeção
  por `Depends`, fáceis de substituir em teste).
- I/O bloqueante sempre via `asyncio.to_thread` (decisão correta, mantida).

## Convenções de código

- pt-BR em docstrings e comentários, focados no **porquê** (não parafraseiam o código).
- Logger por módulo: `logging.getLogger("blip-agent.<modulo>")`.
- `from __future__ import annotations` em módulos cujas classes têm `def list(...)`
  (no 3.12 isso sombrearia o builtin `list` e quebraria anotações `list[...]`).
- Whitelist de campos editáveis em UPDATE (`_EDITABLE`) — nunca interpole nomes de
  coluna vindos do usuário; valores sempre via placeholders `?`.
- Nomes de tenant/agente vêm de `slugify` (ASCII estável); `id` de agente é
  `{tenant}__{slug}` (PK opaca, resolve colisão de slug entre tenants).

## Validação / testes

Não há suíte de unit tests formal ainda; a validação hoje é:
- **Smoke de boot + `TestClient`** (sem depender de Groq/Jina): import do app,
  `init_db`/`init_rag_db`, criar tenant/agente e exercitar o round-trip — valida
  wiring, RBAC, persistência (inclui `skills`) e os fast-paths de 0 token do
  `SkilledAgent` (escalonamento por palavra-chave não chama LLM). É o caminho mais
  rápido e confiável de validar uma mudança hoje.
- **`docs/eval_harness.py`** — avaliação ponta a ponta de embeddings + chat. Rode
  após mexer em RAG/skills/prompts. **Nota:** está defasado do modelo multi-tenant
  (importa `app.tenants`, removido; usa uma API de criação de agente antiga) e
  precisa de um ajuste para rodar de ponta a ponta — a bateria 4 já foi migrada
  para o modelo de skills (`knowledge_search`).

Ao adicionar lógica não-trivial, considere uma checagem reprodutível no mesmo
espírito (banco temporário, sem tocar dados reais). Sempre rode um import/boot da
app antes de concluir.

## Manter a documentação em sincronia

Mexeu na arquitetura? Atualize **`docs/ARQUITETURA.md`**. Mexeu em operação/logs/
fila? **`docs/DEBUG.md`**. O **`README.md` da raiz está defasado** (descreve as
rotas e arquivos antigos) — se for atualizá-lo, alinhe com `ARQUITETURA.md` em vez
de copiar o estado antigo.

## Dívida técnica conhecida (priorização)

Lista curada em `docs/ARQUITETURA.md` §11. O antigo item #1 (classificador de
intenção por palavra-chave, o gargalo de qualidade) foi **resolvido** com o modelo
de skills — o LLM decide a capacidade. Resumo do que resta de maior impacto:
anti-alucinação de catálogo (afirmar só com base nas skills), os itens de segurança
(ver skill `seguranca`) e a decisão de backing das skills (serverless/Lambda).
Trate-os como roadmap, não como bugs soltos — alguns são fundacionais.
