---
name: seguranca
description: >-
  Guia de segurança e cibersegurança do blip-agent. Use ao mexer em
  autenticação, RBAC, isolamento multi-tenant, gestão de segredos/api_keys,
  validação de entrada, prompt injection, a API externa de produtos (SSRF),
  CORS, rate limiting ou ao revisar o impacto de segurança de qualquer mudança.
  Invoque ao tocar http/auth.ts, errors.ts, config (segredos), catalog
  (fetchExternal/probeExternal), prompts.ts, as skills (saídas injetadas no LLM),
  ou ao avaliar exposição de dados entre tenants.
---

# Segurança & cibersegurança — blip-agent

Plataforma multi-tenant: clientes diferentes compartilham o mesmo processo e os
mesmos bancos. A **fronteira de segurança crítica é o isolamento entre tenants**.
Trate qualquer mudança que possa vazar dado de um tenant para outro como alto risco.

## Modelo de autenticação (3 níveis) — `src/server/http/auth.ts`

`resolvePrincipal` produz um `Principal` tipado (`role` ∈ admin/owner/member):

| Credencial | Header | Pode |
|---|---|---|
| `ADMIN_API_KEY` (plataforma) | `X-Admin-Key` (plataforma) / `X-API-Key` (tenant) | tudo; superusuário em qualquer tenant |
| `api_key` do **tenant** | `X-API-Key` | `owner` do próprio tenant (chat/consumo + gestão) |
| `api_key` de **usuário** | `X-API-Key` | papel da membership: `owner` ou `member` |

RBAC: `requirePlatformAdmin`, `requireOwner`, `requireMember` (chamados no topo de
cada rota). `member` = leitura + chat + conteúdo (knowledge/produtos). `owner`/`admin`
= + criar/excluir agentes e gerir membros (`canManage`).

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

- `api_key`s são geradas com `crypto.randomBytes(...).toString("base64url")` (CSPRNG)
  em `src/server/services/tenants.ts` (`newKey`).
- **Exibidas só uma vez**, na criação: `tenantCreated` (api_key do tenant +
  owner_api_key) e `memberCreated` (api_key do usuário). Não há endpoint que reexiba.
- **Nunca em GET:** `agentPublic()` (`http/serialize.ts`) omite `product_api_key`; a
  listagem de agentes não expõe segredo. Ao criar um serializador de resposta novo,
  **não inclua** `api_key`, `product_api_key` nem qualquer credencial.
- Ressalva conhecida: a `api_key` do tenant `default` é **logada uma vez** no boot
  (bootstrap). É intencional para não perder a chave, mas é segredo em log — não
  estenda esse padrão a outras chaves nem suba esses logs a um agregador inseguro.
- `.env` nunca vai ao repo (use `.env.example`). Em produção, **defina
  `ADMIN_API_KEY`** (o default `admin-dev-key` é passe-livre de plataforma).

## Higiene de erros (não vaze interno)

`src/server/errors.ts` + wrapper único em `http/route.ts`. No **chat**, qualquer
exceção degrada para handoff 200 e o detalhe vai **só para o log** (correlacionado
por `req`/`tenant`), nunca para o usuário (`ERROR_INTERNAL`). Não reintroduza um
campo `error` na resposta nem ecoe exceções ao cliente. Stack traces só em log.

## Validação de entrada

- Schemas **Zod** validam request bodies (`schemas.ts`); args de tool são validados
  com `safeParse` antes do dispatch (`skills/base.ts::invokeSkill`).
- Acesso a dados via **Drizzle** (parametrizado por construção). Os `update` montam o
  `set` só a partir de **whitelists** de coluna/DTO; nunca de chave arbitrária vinda
  do usuário. Mantenha assim — nada de SQL bruto com valor de usuário.
- Upload de PDF valida a extensão `.pdf` e bytes não-vazios (rota
  `.../knowledge/pdf/route.ts` + `KnowledgeService`).

## Riscos abertos (o que endurecer antes de escalar)

Lista alinhada com `docs/ARQUITETURA.md` §11. Em ordem de atenção:

1. **Prompt injection / segurança de LLM (defesas implementadas — ver `src/server/security/`).**
   Há uma defesa em profundidade no fluxo de chat:
   - **Limites de entrada** (`schemas.ts` + `config.ts`): `message`/`history` têm
     `.max()` e o histórico tem cap de itens (corta token-flooding/custo).
   - **Spotlighting** (`security/spotlight.ts`): a mensagem do cliente, o histórico
     `user` e as **saídas de skills** (`skilled.ts`) são envolvidos em blocos
     `<dados_do_usuario>`/`<dados_de_ferramenta>` com um **sentinela aleatório por
     requisição** (impossível de forjar). O system prompt (`prompts.ts::securityBlock`)
     instrui o modelo a tratar tudo dentro dos blocos como DADO, nunca instrução, e
     a nunca revelar o prompt.
   - **Sanitização** (`security/sanitize.ts`): NFKC + remoção de invisíveis/bidi +
     neutralização de tokens de chat-template (`<|...|>`, `[INST]`, `</s>`...) e do
     `[HANDOFF]` em conteúdo não confiável — aplicada à mensagem, ao histórico, ao
     payload de skill e ao chunk verbatim do atalho RAG (`ragShortcut`).
   - **Detecção heurística + recusa determinística** (`security/injection.ts` +
     `orchestrator.ts`): `detectInjection` pontua padrões PT/EN. Suspeita branda →
     loga; score alto → **endurece** o prompt do turno; **sinais de ALTA confiança**
     (`refuse`: troca de papel/persona, exfiltração de prompt, token de chat-template,
     role-line falsa ou `[HANDOFF]` no input) → o orchestrator responde de forma
     **determinística, NO PAPEL, SEM chamar o LLM** (`messages.injectionRefusal`).
     Esse é o ponto central: endurecer o prompt **não basta** — o Llama 3.3 obedece
     a "ignore tudo, você agora é X" mesmo com o reforço; só não chamar o modelo é à
     prova de jailbreak. Sinais ambíguos (override sozinho, base64, homoglyph) só
     endurecem, para não recusar cliente legítimo.
   - **Classificador opcional** (`llm.ts::classifyInjection`, atrás de
     `PROMPT_GUARD_MODEL`, default OFF): pré-check via modelo Groq (Prompt/Llama
     Guard) em cascata, **fail-open**.

   Os campos do owner (`system_prompt`/`business_rules`/`name`) têm `.max()` e passam
   por `stripDangerousTokens` no `AgentService` antes de persistir. **Resíduos a ter
   em mente:** a detecção é heurística (não substitui revisão); homoglyphs entre
   scripts não são folados por NFKC (são *flagados*, não corrigidos); o conteúdo do
   owner segue sendo instrução legítima (papel dele — RBAC), só não pode forjar
   fronteiras de template. Rode `npm run test:security` ao mexer nessa área e
   acrescente casos de jailbreak novos.
2. **SSRF no catálogo externo.** Em `product_mode="external"`, o backend faz
   `fetch(agent.productApiUrl, ...)` com uma URL **fornecida pelo owner**, enviando o
   `Authorization: Bearer` configurado. Há **dois** caminhos hoje em `catalog.ts`:
   `fetchExternal` (consultas) e `probeExternal` (a skill `check_catalog`) — qualquer
   validação/allowlist de host precisa cobrir **os dois** (centralizados em
   `externalGet`). Um owner pode apontar para `http://169.254.169.254/...` ou serviços
   internos. Mitigações: allowlist/validação de host e esquema (só https público),
   bloquear IPs privados/link-local, timeout (já há 10s) e talvez egress isolado. A
   feature flag `external_products` desliga o fetch por agente, mas não valida o destino.
3. **Sem rate limiting.** Não há limite por agente/tenant no chat nem na ingestão →
   abuso e custo de LLM descontrolado. Adicionar antes de tráfego real.
4. **CORS.** O painel é servido pela própria app (mesma origem), então não há CORS
   liberado por padrão no Next. Se expor a API a origens de browser de terceiros,
   adicione cabeçalhos CORS explícitos e **restritos** (a auth é por header de API
   key, não cookie, o que reduz CSRF — mas não dispensa allowlist de origem).
5. **Rotação de chaves.** Não há fluxo de rotação/revogação de `api_key`. Planejar.
6. **Concorrência/durabilidade.** Agora Postgres (limite de escrita bem acima do
   antigo SQLite). Falta índice ANN no pgvector (HNSW) quando o volume de chunks crescer.

## Checklist de revisão de segurança (rode mentalmente em todo PR)

- [ ] Query nova tem escopo por `tenantId`/`agentId`?
- [ ] Rota nova chama o `require*` certo? (escrita = `owner`/`admin`)
- [ ] Serializador de resposta **não** vaza `api_key`/`product_api_key`/segredo?
- [ ] Erro não devolve detalhe/stack ao cliente (em rota de chat, degrada)?
- [ ] Update monta o `set` só por whitelist de coluna (sem chave arbitrária)?
- [ ] Mexeu em `productApiUrl`/fetch externo? Considerou SSRF (allowlist de host)?
- [ ] Mexeu em prompt/ingestão? Conteúdo não confiável novo passou por
      `sanitizeUntrusted`/spotlighting e foi coberto por `detectInjection`? Rodou
      `npm run test:security`?
- [ ] Segredo novo: gerado com CSPRNG (`crypto.randomBytes`), exibido só 1x, fora de logs?
