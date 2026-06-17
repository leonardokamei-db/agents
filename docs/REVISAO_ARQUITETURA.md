# Revisão de arquitetura — blip-agent

Análise dos 19 pontos de feedback da empresa, validados **contra o código real**
(arquivo:linha), com criticidade sob a ótica de "isto vai virar um SaaS
multi-tenant de produção (mini Blip Studio)", correções concretas, grafo de
dependências e plano de execução em fases.

> Metodologia: cada cluster de pontos foi revisado por um analista lendo os
> arquivos citados; uma síntese montou o grafo de dependências; e uma revisão
> adversarial validou criticidades e achou erros na própria análise (ver
> §"Correções da revisão"). As correções já estão incorporadas abaixo.

---

## Resumo executivo

O blip-agent é um **protótipo bem-arquitetado para o estágio atual** — isso
precisa ser dito antes das críticas. `BaseAgent` com contrato `execute` (pontos
1 e 4), `Orchestrator` com `classifier` extraído, logging hierárquico
`blip-agent.*` com lazy formatting (ponto 6) e o uso **correto** de
`asyncio.to_thread` para o I/O bloqueante de Groq/Jina (ponto 7) são decisões
sólidas que devem ser **endurecidas, não desfeitas**.

Vários itens da lista são **parciais ou exagerados** para o tamanho atual: não
há "arquivos .py soltos" (são módulos coesos), não é "tudo dict" (primitivos e
os modelos de API já são tipados), e migrar para Celery/LangGraph seria
over-engineering. `schemas.py` com 110 linhas e `orchestrator.py` com 78 não são
problema de escala hoje.

O problema **real** para virar SaaS de produção é triplo:

1. **Tenant fundido com agent (ponto 19)** — hoje `1 cliente = 1 agente = 1 api_key`.
   Quebra billing por cliente, RBAC e compartilhamento de catálogo/base entre
   agentes do mesmo cliente. É a causa-raiz do ponto 8.
2. **Não existe camada de dados (ponto 15)** — SQL cru espalhado em ~10 lugares
   onde o isolamento por `agent_id` depende de disciplina manual. É o vetor do
   pior risco de multi-tenancy (vazamento entre tenants) e o bloqueio para sair
   do SQLite rumo ao Postgres.
3. **Contratos internos são dicts opacos com magic strings (ponto 3)** — que se
   propagam para o retorno do agente (2), input de método (13), cliente LLM (14)
   e camada de dados (16). Qualquer renomeação quebra só em runtime, por tenant,
   por fluxo.

E há **um furo de segurança imediato** (ver ponto 8 abaixo) que não é debt de
arquitetura e deve ser tapado já.

---

## Tabela de criticidade (pós-revisão adversarial)

| # | Ponto | Procede? | Criticidade | Esforço |
|---|-------|----------|-------------|---------|
| 8a | **Credencial: `ADMIN_API_KEY` global autentica qualquer agente + `GET /v1/agents` vaza a api_key de todos** | sim | 🔴 **Crítico (segurança)** | S |
| 19 | Tenant fundido com agent (deveria ser tenant com N agents) | sim | 🟠 Alto (fundacional) | XL |
| 15 | Sem repositório; SQL cru; tenant scoping manual | sim | 🟠 Alto (fundacional) | L |
| 3 | Magic strings nas chaves de dicts (causa-raiz) | sim | 🟠 Alto | L |
| 2 | Retorno do BaseAgent não tipado (dict genérico) | sim | 🟠 Alto | M |
| 14 | `self.llm` e retorno de tools não tipados | sim | 🟠 Alto | M |
| 16 | Queries/camada de dados sem tipo (`row_to_dict -> dict`) | sim | 🟠 Alto | M |
| 10 | Sem camada única de erros; status codes espalhados | sim | 🟠 Alto | L |
| 8b | Sem RBAC/feature flags (papéis, planos) | sim | 🟠 Alto (após 19) | L |
| 5 | Strings de erro/copy espalhadas e divergentes | sim | 🟡 Médio | S |
| 13 | Inputs estruturados não tipados (`agent: dict`, `history: List[dict]`) | parcial | 🟡 Médio | M |
| 9 | Logging sem correlação por requisição/tenant; sem DEBUG.md | parcial | 🟡 Médio | M |
| 7 | Threads vs workers (Celery) | parcial | 🟡 Médio | M |
| 12 | Routers sem camada de service/handler | parcial | 🟡 Médio | L |
| 18 | Divisão do `orchestrator.py` / agentes recriados por request | parcial | 🟢 Baixo | M |
| 11 | `schemas.py` único | parcial | 🟢 Baixo | S |
| 17 | Estilo das tools vs LangGraph | parcial | 🟢 Baixo | M |
| 1 | BaseAgent (padronização) | sim | ✅ Positivo (preservar) | S |
| 4 | Padrão use-case `execute()` | sim | ✅ Positivo (preservar) | S |
| 6 | Logger hierárquico bem feito | sim | ✅ Positivo (preservar) | S |

---

## Correções da revisão (importante antes de executar)

A revisão adversarial achou três coisas que mudam o plano. **São o item mais
valioso desta análise** — sem elas, a Fase 1 quebraria.

### C1. O ponto 2 como descrito quebra em runtime
`ChatResponse` (schemas.py:64-76) exige `intent` e `agent_used` como campos
**obrigatórios** — e **nenhum agente os produz**: são injetados depois pelo
`Orchestrator.process` via `result.update(intent=, agent_used=)`
(orchestrator.py:55-59). Logo, um `AgentResult` com só
`response/should_handoff/source/tokens_used` faria
`ChatResponse.model_validate(...)` **explodir em ValidationError**.

→ **Correção:** dois contratos, não um. `AgentResult` (saída do agente) ≠
`ChatResponse` (contrato da API). O orchestrator é quem completa o contrato
(`OrchestratorResult = AgentResult + metadados de roteamento`). Isso **acopla o
ponto 2 ao ponto 18** (que mexe exatamente nessa junção) — devem ser feitos
juntos, não em fases separadas.

### C2. Pontos 10 e 4 querem coisas opostas no chat
O ponto 10 quer que erros de domínio tipados **subam** até um handler (ex.: rate
limit do Groq → 429). O ponto 4 (positivo) elogia que os agentes **degradam
internamente** e o orchestrator tem um `except Exception` que devolve
200 + handoff (orchestrator.py:66). Uma `LLMRateLimited` num chat seria
**engolida** pelo orchestrator e nunca viraria 429.

→ **Correção:** definir uma **regra explícita de degrade-vs-propagate**. Proposta:
no caminho de **chat**, erros de LLM/embedding **degradam** para 200 + handoff
(experiência do usuário final > status HTTP); nos endpoints de **admin/config/
knowledge/products**, erros de domínio **propagam** com status tipado. O
`except` do orchestrator deve capturar só o que decidimos degradar, não tudo.

### C3. O ponto 8 é segurança, não só modelagem — e estava subestimado
`require_agent` aceita a `ADMIN_API_KEY` global para **qualquer** agente
(deps.py:25), o default é fraco e hardcoded (`'admin-dev-key'`, config.py:38), e
`GET /v1/agents` retorna a **api_key de todos os agentes em texto puro**
(admin.py:32). Isso é **vazamento de credencial de todos os clientes via um único
segredo** → promovido a **Crítico** e separado em **8a** (tapar já) e **8b**
(RBAC/planos, depois da entidade tenant).

### Ajuste de evidência (ponto 19)
`rag.db` **já** usa a coluna `tenant_id` (rag.py:47), enquanto `core.db` usa
`agent_id`. Há **incoerência de nomenclatura** entre os dois bancos que a
migração do ponto 19 precisa reconciliar.

---

## Grafo de dependências

```
3 (tipos base) ──┬─► 2 (saída agente) ──► (acoplado a) 18 (orchestrator)
                 ├─► 13 (inputs)
                 ├─► 14 (LLM tipado) ─┐
                 ├─► 16 (dados tipados)│
                 └─► 17 (tools) ◄──────┘   (17 depende de 13 e 14)

15 (repositório) ──┬─► 12 (services)
                   ├─► 10 (camada de erros) ◄── 5 (copy centralizada)
                   ├─► 7 (concorrência/WAL)
                   └─► (facilita) 19

19 (entidade tenant) ──┬─► 8b (RBAC + feature flags)
                       └─► 9 (correlação de log por tenant)

8a (segurança) — independente, fazer já
1, 4, 6 — positivos, preservar com testes de contrato
11 — independente, baixa prioridade (decisão consciente de adiar)
```

**Fundacionais (destravam o resto):** 3, 15, 19, 5.
**Quick wins (baixo esforço, sem dependência):** 8a (segurança), 6, 1, 4, 11.

---

## Plano em fases

### Fase 0 — Segurança imediata + congelar fundações *(dias)*
- **8a:** remover o default `'admin-dev-key'` (falhar o boot sem `ADMIN_API_KEY`
  forte); **parar de retornar `api_key` no `GET /v1/agents`** (admin.py:32).
- Testes de contrato que instanciam cada subclasse de `BaseAgent` e validam a
  forma do retorno (`response/should_handoff/source`) — **congela 1 e 4** antes
  de mexer em tipos.
- Documentar a convenção de logger `blip-agent.*` (protege 6).
- Decisão consciente: **não** quebrar `schemas.py` agora (11).

### Fase 1 — Tipos compartilhados *(aditivo, não muda runtime)*
- **3:** criar `ChatMessage`, `AgentConfig`, `ProductRow` (TypedDict/dataclass).
- **2 + 18 (juntos, ver C1):** `AgentResult` para a saída do agente e
  `OrchestratorResult`/`ChatResponse` montado no orchestrator; extrair
  `_select_agent` e cachear o orchestrator por agente.
- **14:** anotar `llm: LLMClient`; tipar retorno de `complete_with_tools`.
- **13** e **16:** inputs e fronteira de dados tipados.
- **17:** registry de tools + args validados por Pydantic (depende de 13 e 14).
- Ligar **mypy/pyright no CI** ao fim da fase.

### Fase 2 — Camada de dados + copy *(fundacional)*
- **15:** `app/repositories/` (AgentRepository, ProductRepository) com
  `WHERE tenant_id = ?` como **invariante da classe** (não disciplina manual);
  helper `with transaction()` para matar o `connect()/try/finally` repetido.
- **5:** `app/messages.py` com as constantes de copy (sem override por tenant
  ainda — ver "O que não fazer").

### Fase 3 — Erros únicos + orchestrator *(depende da Fase 2)*
- **10:** `app/errors.py` (hierarquia `AppError` com status) +
  `@app.exception_handler`; **aplicar a regra degrade-vs-propagate (C2)**;
  remover `error=str(e)` do corpo (e o campo órfão `ChatResponse.error`).
- **12:** camada de services **se** justificar (opcional — repository já resolve
  testabilidade e tenant scoping; não criar duas camadas só por padrão).

### Fase 4 — Entidade tenant de primeira classe *(XL, isolar pelo blast radius)*
- **19:** tabela `tenants`; `tenant_id` em `agents`; renomear `app/tenants.py`
  (que cuida de agents) → `app/agents.py` e criar `tenants.py` real; mover
  credencial para o nível do tenant; prefixar `agent_id` por tenant (resolve a
  colisão de slugs que hoje bloqueia o 2º cliente com "minha-loja"); reconciliar
  `tenant_id` vs `agent_id` entre os dois bancos. Mais seguro **depois** de 3 e
  15 (repos tipados fazem o compilador apontar quem muda).

### Fase 5 — Autorização + observabilidade + concorrência
- **8b:** `require_permission` sobre `memberships` (começar com 1-2 papéis, não
  4); feature flags por plano.
- **9:** `request_id` via middleware + `contextvar` de tenant no formatter;
  `LOG_LEVEL` por env; `DEBUG.md`; logs no caminho feliz do OrderAgent.
- **7:** **WAL no rag.db** (1 linha, pode antecipar) + ThreadPoolExecutor
  dimensionado; **adiar** semáforo por tenant e fila de ingestão até medir
  saturação real.

---

## O que NÃO fazer agora (over-engineering)

- **Celery no caminho de chat** (ponto 7): `asyncio.to_thread` está correto para
  I/O-bound. Fila só para ingestão de PDF, e só quando virar SaaS.
- **LangGraph** (ponto 17): peso e acoplamento desnecessários; um registry de
  tools na stack atual resolve.
- **Quebrar `schemas.py`** (ponto 11) com 110 linhas: adiar até ~300-400 linhas.
- **RBAC com 4 papéis** (ponto 8b) antes de existir o primeiro usuário nomeado:
  tapar o furo de credencial (8a) é o que importa agora.
- **Override de copy por tenant** (ponto 5): centralizar a string é quick-win;
  o mecanismo de override é requisito que ninguém pediu ainda.
- **Postgres** antes da camada de repositório (ponto 15) que torna a troca barata.
- **Semáforo/fila/métrica de concorrência** (ponto 7) antes de **um** número de
  saturação medido.
