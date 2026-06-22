---
name: backend
description: >-
  Playbook de backend do blip-agent (FastAPI + Groq + RAG). Use ao adicionar ou
  alterar endpoints, skills (capacidades do agente), o agente flexível,
  orquestração, RAG, catálogo, integração com LLM ou acesso a dados. Cobre as
  camadas (routers → services → repositories → domínio), o fluxo de chat por
  skills, contratos tipados, regra async/bloqueante e tratamento de erros.
  Invoque ao mexer em qualquer coisa sob app/ que não seja puramente
  deploy/segurança/organização.
---

# Backend — blip-agent

Backend multi-tenant de agentes de atendimento. **FastAPI** (assíncrono) + **Groq**
(LLM) + **RAG** (sqlite-vec + embeddings Jina) + **SQLite**. Veja a visão completa em
`docs/ARQUITETURA.md`; este skill é o **como fazer** no dia a dia.

## A regra de ouro: 4 camadas, dependência só "para baixo"

```
routers/  → só HTTP (validação Pydantic, status, Depends). SEM regra de negócio, SEM SQL.
services/ → regra de negócio. Levanta AppError. Orquestra repositórios/catalog/rag.
repositories/ → TODO o SQL cru. Único lugar que abre conexão. Retorna tipos de domínio.
domain.py → tipos (AgentConfig, ProductRow, AgentResult, Principal, ...). Sem I/O.
```

Violações que **nunca** devem entrar:
- SQL fora de `app/repositories/*` (nem em service, nem em router).
- Regra de negócio ou `if product_mode == ...` dentro de um router.
- Dict opaco com magic strings cruzando camadas — use os tipos de `domain.py`.
- Router levantando `HTTPException` com status cru — levante um `AppError` (§Erros).

## Recurso novo de ponta a ponta (o caminho feliz)

Para adicionar/alterar um recurso, siga a cadeia inteira:

1. **Schema** (`app/schemas/<dominio>.py`): `XCreate`/`XUpdate`/`XInfo` (Pydantic).
   Reexporte em `app/schemas/__init__.py`. Segredos **nunca** entram num schema de
   resposta (ver `AgentPublic`, que não tem `product_api_key`).
2. **Repository** (`app/repositories/<dominio>.py`): métodos com SQL. Use
   `with transaction() as conn:` (escrita) ou `with read_connection() as conn:`
   (leitura) de `app/db.py`. Toda query escopada por tenant/agente
   (`WHERE agent_id = ?` / `WHERE tenant_id = ?`) — é invariante de isolamento.
   Use whitelist de colunas em UPDATE (ver `_EDITABLE`).
3. **Service** (`app/services/<dominio>.py`): regra de negócio + validação; levanta
   `AppError`. Stateless (só segura repositórios). Exponha um singleton + getter
   `get_x_service` em `app/services/__init__.py`.
4. **Router** (`app/routers/<dominio>.py`): injeta o service via `Depends(get_x_service)`,
   o agente via `Depends(resolve_agent)` e o RBAC via `Depends(require_member/owner)`.
   Monte em `app/main.py` (`app.include_router(...)`).

Endpoints de agente ficam sob o prefixo `/v1/tenants/{tenant_id}/agents/{agent_slug}/...`.

## O agente flexível (SkilledAgent) + skills

Não há mais um agente por intenção nem classificador de palavra-chave. Existe
**um** agente de conversa, o `SkilledAgent` (`app/agents/skilled.py`): recebe as
skills habilitadas do agente e deixa o **LLM decidir qual chamar** (function
calling). Há ainda o `FallbackAgent` estático (limite de turnos / erro). Para
mudar o comportamento de conversa, em quase todos os casos você **adiciona ou
ajusta uma skill**, não um agente.

## Adicionar uma skill (o caminho comum)

Uma skill é uma capacidade discreta com contrato único — schema (function calling)
e implementação saem da **mesma fonte** (o registry em `app/skills/base.py`):

```python
# app/skills/<dominio>.py
from pydantic import BaseModel
from app import catalog
from app.skills.base import CATEGORY_CATALOG, SkillContext, SkillResult, skill

class MinhaArgs(BaseModel):
    campo: str

@skill("minha_skill", "Descrição que o modelo lê para decidir chamar.",
       MinhaArgs, category=CATEGORY_CATALOG)
def _minha_skill(ctx: SkillContext, args: MinhaArgs) -> SkillResult:
    dados = catalog.algo(ctx.agent, args.campo)   # use a camada certa (catalog/rag)
    return SkillResult(data=dados)                # data = JSON devolvido ao LLM
```

Passos:
1. Implemente no submódulo certo de `app/skills/` (knowledge/catalog/support) e
   **importe-o em `app/skills/__init__.py`** — é esse import que roda o `@skill` e
   popula o `REGISTRY`.
2. Escolha a `category` (`CATEGORY_KNOWLEDGE`/`CATALOG`/`SUPPORT`/`GENERAL`): é o
   que faz a skill ser derivada das flags em `enabled_skills_for` quando o agente
   não declara skills explícitas.
3. Sinais de controle no `SkillResult`: `handoff`/`handoff_reason` (pede humano);
   `direct_response` (resposta pronta → skill **terminal**, encerra o turno sem
   mais LLM, como `escalate_to_human`); `sources` (proveniência RAG).
4. Não há lista de tools para editar à mão: `tool_schemas_for`/`invoke_skill`
   derivam do registry. O `SkilledAgent` roda o loop dentro de `asyncio.to_thread`
   com teto (`MAX_TOOL_ITERATIONS`) e retries para `tool_use_failed` (glitch
   transitório do Groq, em `app/llm.py`).
5. Valide nomes no serviço: `AgentService._check_skills` rejeita skill fora do
   registry (400). Skill nova → ela passa a ser selecionável por agente.

**Skill remota (futuro, AWS Lambda):** o contrato é serializável de propósito.
Para rodar uma skill fora do processo, crie uma subclasse de `Skill` (ex.:
`RemoteSkill`, `kind="lambda"`) cujo `invoke(ctx, args)` chame o backend remoto e
devolva um `SkillResult`; registre com `register(...)`. Registry, agente e schema
**não mudam** — só o transporte. Hoje tudo é `LocalSkill` (in-process), de propósito.

Se precisar mesmo de um **novo agente** (raro): subclasse de `BaseAgent` em
`app/agents/`, implemente `system_prompt`/`execute` retornando `AgentResult` e
ligue-o no `Orchestrator`. O token `[HANDOFF]` (`prompts.HANDOFF_TOKEN`) ainda
sinaliza transferência no texto do modelo. Quase sempre uma skill é o lugar certo.

## Regra async / bloqueante (importante)

O SDK do Groq, o HTTP da Jina e o SQLite são **síncronos/bloqueantes**. Nunca os
chame direto numa função `async`: envolva em `await asyncio.to_thread(fn, ...)`,
como já fazem `LLMClient.complete`, o `SkilledAgent` (loop de skills + atalho RAG)
e os routers de knowledge (ingestão). As skills são **síncronas** — o agente já as
chama dentro de uma thread. O event loop do FastAPI não pode bloquear.

## Contratos tipados

- `AgentResult` = saída do **agente**. `ChatResponse` = contrato da **API**. São
  diferentes: `intent`/`agent_used`/`confidence` são injetados pelo Orchestrator,
  não pelo agente. Não funda os dois. (`intent` agora é derivado das skills usadas.)
- `SkillResult` = saída de uma **skill** (`data` JSON + sinais `handoff`/
  `direct_response`/`sources`). Serializável de propósito (fronteira p/ Lambda).
- `ProductRow` tem o **mesmo shape** para catálogo interno (`from_db_row`) e externo
  (`from_external`).
- `AgentConfig` é `frozen=True` — por isso o `Orchestrator` é cacheável por config
  (`lru_cache` em `app/routers/agent.py::_orchestrator_for`); editar a config gera
  uma chave nova e invalida o cache sozinho. **`skills` é uma `tuple`** (não list)
  justamente para manter o `AgentConfig` hashável.

## Erros (degrade vs. propagate)

Levante `AppError` tipado de `app/errors.py` (`NotFoundError` 404, `ConflictError`
409, `ValidationError` 400, `Unauthorized` 401, `Forbidden` 403,
`EmbeddingUnavailableError` 503). O handler único em `main.py` serializa
`{code, detail}`.

- **No chat**, qualquer erro **degrada** para handoff 200 (o `try/except` do
  `Orchestrator` captura). O `str(e)` vai **só para o log** — nunca para o usuário.
- **Em admin/config/knowledge/products**, o `AppError` **propaga** com status tipado.

Mensagens ao usuário final ficam centralizadas em `app/messages.py` — não escreva
copy nova solta no código.

## Economia de tokens (não regrida nisso)

`HISTORY_LIMIT=5`, prompts compactos (`prompts.py`, só as regras das skills
habilitadas), `RAG_TOP_K=3`, atalho RAG sem LLM (`faq_shortcut`, dist. ≤ 0.90) e
escalonamento determinístico de suporte (0 tokens), ambos no `SkilledAgent`. O
classificador por palavra-chave foi **removido** (era a fonte das falhas de
roteamento): hoje o LLM decide a skill. Os dois atalhos de 0 token foram
preservados; mudanças que aumentem tokens devem ser justificadas.

## Convenções

- Logger por módulo: `logging.getLogger("blip-agent.<modulo>")`. Logs saem
  correlacionados por `req`/`tenant` automaticamente (`logging_ctx.py`).
- Docstrings/comentários em **pt-BR**, explicando o *porquê*.
- Em módulos com `def list(...)` numa classe, ponha `from __future__ import
  annotations` no topo — sem isso o `list[...]` de outra anotação quebra no 3.12
  (ver `services/tenants.py`).
- `slugify`/`word_set`/`normalize` vêm de `app/textutil.py` — não reinvente.

## Onde mexer (atalho)

| Quero… | Vá em |
|---|---|
| nova capacidade do agente | `app/skills/<dominio>.py` (+ registrar em `skills/__init__.py`) |
| nova skill de catálogo | `skills/catalog.py` (+ `catalog.py` se for nova fonte de dado) |
| comportamento de conversa / prompt | a skill certa + `prompts.skilled_prompt` |
| como o agente roda as skills | `agents/skilled.py` (fast-paths + loop) |
| quais skills um agente tem | `skills/base.py::enabled_skills_for` (explícito vs. flags) |
| chunking/busca RAG | `rag.py` (+ `embeddings.py`) |
| novo campo de config do agente | `db.py` (DDL + migração), `domain.AgentConfig`, `schemas/agent.py`, `repositories/agents.py::_EDITABLE` |
| nova credencial/papel | `routers/deps.py`, `domain.Principal` (e ver o skill `seguranca`) |

Antes de finalizar: rode um import/smoke do app e atualize `docs/ARQUITETURA.md`
se a arquitetura mudou.
