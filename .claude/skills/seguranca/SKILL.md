---
name: seguranca
description: >-
  Guia de segurança e cibersegurança do blip-agent. Use ao mexer em
  autenticação, RBAC, isolamento multi-tenant, gestão de segredos/api_keys,
  validação de entrada, prompt injection, a API externa de produtos (SSRF),
  CORS, rate limiting ou ao revisar o impacto de segurança de qualquer mudança.
  Invoque ao tocar deps.py, errors.py, config (segredos), catalog._fetch_external/
  _probe_external, prompts.py, as skills (saídas injetadas no LLM), ou ao avaliar
  exposição de dados entre tenants.
---

# Segurança & cibersegurança — blip-agent

Plataforma multi-tenant: clientes diferentes compartilham o mesmo processo e os
mesmos bancos. A **fronteira de segurança crítica é o isolamento entre tenants**.
Trate qualquer mudança que possa vazar dado de um tenant para outro como alto risco.

## Modelo de autenticação (3 níveis) — `app/routers/deps.py`

`_resolve_principal` produz um `Principal` tipado (`role` ∈ admin/owner/member):

| Credencial | Header | Pode |
|---|---|---|
| `ADMIN_API_KEY` (plataforma) | `X-Admin-Key` (plataforma) / `X-API-Key` (tenant) | tudo; superusuário em qualquer tenant |
| `api_key` do **tenant** | `X-API-Key` | `owner` do próprio tenant (chat/consumo + gestão) |
| `api_key` de **usuário** | `X-API-Key` | papel da membership: `owner` ou `member` |

RBAC por dependências: `require_platform_admin`, `require_owner`, `require_member`.
`member` = leitura + chat + conteúdo (knowledge/produtos). `owner`/`admin` =
+ criar/excluir agentes e gerir membros (`Principal.can_manage`).

Diagnóstico: **401** = chave ausente/inválida; **403** = chave válida sem permissão
(tenant errado, ou `member` tentando gerir); **404** = agente não existe *naquele
tenant* (isolamento funcionando).

## Isolamento multi-tenant (a invariante que protege tudo)

- Agente é resolvido por **`(tenant_id, slug)`** do path; o `id` é prefixado
  (`{tenant}__{slug}`) para não colidir entre tenants.
- **Todo** acesso a produto/RAG é escopado por `agent_id`; agentes/membros por
  `tenant_id`. Isso é **garantia da camada de repositórios**, não disciplina do
  chamador. Ao escrever uma query nova, ela **precisa** ter `WHERE agent_id = ?` /
  `WHERE tenant_id = ?`. Uma query sem escopo é um vazamento entre tenants.
- Validado por smoke: chave de um tenant em agente de outro → 403; agente de outro
  tenant → 404 (ver `REVISAO_ARQUITETURA.md`).

**Regra de revisão:** qualquer PR que adicione SQL fora dos repositórios, ou um
método de repositório sem o filtro de escopo, é bloqueante.

## Gestão de segredos

- `api_key`s são geradas com `secrets.token_urlsafe` (CSPRNG) — `tenants.py`/`db.py`.
- **Exibidas só uma vez**, na criação: `TenantCreated` (api_key do tenant +
  owner_api_key) e `MemberCreated` (api_key do usuário). Não há endpoint que reexiba.
- **Nunca em GET:** `AgentPublic`/`agent_public()` omitem `product_api_key`; a
  listagem de agentes não expõe segredo. Ao criar um schema de resposta novo, **não
  inclua** `api_key`, `product_api_key` nem qualquer credencial.
- Ressalva conhecida: a `api_key` do tenant `default` é **logada uma vez** no boot
  (bootstrap). É intencional para não perder a chave, mas é segredo em log — não
  estenda esse padrão a outras chaves nem suba esses logs a um agregador inseguro.
- `.env` nunca vai ao repo (use `.env.example`). Em produção, **defina
  `ADMIN_API_KEY`** (o default `admin-dev-key` é passe-livre de plataforma).

## Higiene de erros (não vaze interno)

`app/errors.py` + handler único em `main.py`. No **chat**, qualquer exceção degrada
para handoff 200 e o `str(e)` vai **só para o log** (correlacionado por `req`/
`tenant`), nunca para o usuário (`ERROR_INTERNAL`). Não reintroduza um campo `error`
na resposta nem ecoe exceções ao cliente. Stack traces só em log.

## Validação de entrada

- Schemas Pydantic validam request bodies; args de tool são validados com
  `model_validate` antes do dispatch (`tools.py`).
- SQL é **parametrizado** em todo lugar (placeholders `?`). Os `UPDATE` dinâmicos
  montam o `SET` só a partir de **whitelists** de coluna (`_EDITABLE`); nunca a
  partir de chave vinda do usuário. Mantenha assim — nada de f-string com valor de
  usuário em query.
- Upload de PDF valida a extensão e bytes não-vazios (`routers/knowledge.py`).

## Riscos abertos (o que endurecer antes de escalar)

Lista alinhada com `docs/ARQUITETURA.md` §11. Em ordem de atenção:

1. **Prompt injection / segurança de LLM.** `system_prompt` e `business_rules` são
   editáveis pelo cliente e **concatenados direto** no prompt (`prompts.py`); o
   conteúdo recuperado por RAG também é injetado; e agora **as saídas das skills**
   (chunks de `knowledge_search`, dados de catálogo, retorno de uma futura skill
   remota) voltam ao LLM como mensagens `tool`. Vetores: um owner malicioso, um
   documento envenenado na base **ou um catálogo/skill que devolva texto malicioso**
   altera o comportamento do bot, exfiltra o prompt, ou força ações. **Antes de
   expor amplamente:** política de sanitização/limites, separação clara de
   instrução vs. dado (inclusive no payload de skill), e testes de jailbreak. Área
   que pede revisão de quem tem experiência em segurança de LLM.
2. **SSRF no catálogo externo.** Em `product_mode="external"`, o backend faz
   `requests.get(agent.product_api_url, ...)` com uma URL **fornecida pelo owner**,
   enviando o `Authorization: Bearer` configurado. Há **dois** caminhos hoje:
   `catalog._fetch_external` (consultas) e `catalog._probe_external` (a skill
   `check_catalog`) — qualquer validação/allowlist de host precisa cobrir **os
   dois**. Um owner pode apontar para `http://169.254.169.254/...` ou serviços
   internos. Mitigações: allowlist/validação de host e esquema (só https público),
   bloquear IPs privados/link-local, timeout (já há 10s) e talvez egress isolado. A
   feature flag `external_products` desliga o fetch por agente, mas não valida o destino.
3. **Sem rate limiting.** Não há limite por agente/tenant no chat nem na ingestão →
   abuso e custo de LLM descontrolado. Adicionar antes de tráfego real.
4. **CORS aberto.** `main.py` usa `allow_origins=["*"]` + métodos/headers `*`. A
   auth é por header de API key (não cookie), o que reduz o risco de CSRF, mas
   restrinja as origens em produção.
5. **Rotação de chaves.** Não há fluxo de rotação/revogação de `api_key`. Planejar.
6. **Concorrência/durabilidade.** SQLite arquivo único (atenuado por WAL); escrita
   concorrente alta é limite. Caminho: Postgres.

## Checklist de revisão de segurança (rode mentalmente em todo PR)

- [ ] Query nova tem escopo por `tenant_id`/`agent_id`?
- [ ] Endpoint novo tem o `require_*` certo? (escrita = `owner`/`admin`)
- [ ] Schema de resposta **não** vaza `api_key`/`product_api_key`/segredo?
- [ ] Erro não devolve `str(e)`/stack ao cliente (em rota de chat, degrada)?
- [ ] Entrada de usuário em SQL passa por placeholder + whitelist de coluna?
- [ ] Mexeu em `product_api_url`/fetch externo? Considerou SSRF (allowlist de host)?
- [ ] Mexeu em prompt/ingestão? Considerou injeção via config ou documento?
- [ ] Segredo novo: gerado com `secrets`, exibido só 1x, fora de logs?
