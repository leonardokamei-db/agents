# Configuração de agentes — guia por time (curl + endpoints)

Plataforma multi-tenant de agentes de atendimento. Este guia cobre o que cada time
precisa: **dev** (curl de configuração), **UX** (assistente de IA + skills) e
**dados** (dashboard). Os contratos HTTP são **snake_case**; segredos
(`product_api_key`) nunca voltam num GET.

Variáveis usadas nos exemplos:

```bash
BASE="http://localhost:3000"      # em produção, a URL do Railway
TENANT="default"                  # id do tenant
SLUG="demo"                       # slug do agente
KEY="admin-dev-key"               # X-API-Key: chave do tenant ou a ADMIN_API_KEY
```

## Autenticação (resumo)

| Credencial | Header | Pode |
|---|---|---|
| `ADMIN_API_KEY` (plataforma) | `X-Admin-Key` (plataforma) / `X-API-Key` (tenant) | tudo; superusuário em qualquer tenant |
| `api_key` do **tenant** | `X-API-Key` | dono do tenant (chat + gestão) |
| `api_key` de **usuário** | `X-API-Key` | papel da membership (`owner`/`member`) |

- **member**: leitura, chat, conteúdo, **dashboard** e **catálogo de skills**.
- **owner/admin**: o acima + criar/editar agentes, gerir membros e **gerar config com IA**.

---

## 1) Time de DEV — curl de configuração do agente

### Criar um agente (owner) — abre o endpoint `/chat`

```bash
curl -sS -X POST "$BASE/v1/tenants/$TENANT/agents" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "minha-loja",
    "name": "Minha Loja",
    "system_prompt": "Você é o assistente virtual da Minha Loja. Responda em português, de forma breve e cordial.",
    "business_rules": "Troca em até 7 dias. Frete grátis acima de R$ 199.",
    "max_turns": 15,
    "product_mode": "none",
    "product_api_url": "",
    "product_api_key": "",
    "rag_enabled": true,
    "external_products": true,
    "skills": ["knowledge_search", "escalate_to_human", "create_ticket"]
  }'
```

- `slug` é opcional (derivado do `name` se omitido). `product_mode`: `none` | `internal` | `external`.
- `skills` vazio (`[]`) = conjunto derivado das flags (RAG → knowledge; catálogo → catalog; suporte/gerais sempre).

### Editar a configuração (owner) — vale já na próxima mensagem

```bash
curl -sS -X PUT "$BASE/v1/tenants/$TENANT/agents/$SLUG/config" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "system_prompt": "Você é o assistente virtual da Minha Loja...",
    "business_rules": "Troca em até 7 dias. Reembolso se atraso > 7 dias.",
    "max_turns": 15,
    "rag_enabled": true,
    "skills": ["knowledge_search", "escalate_to_human", "create_ticket"]
  }'
```

Envie só os campos que quer alterar (merge parcial). `product_api_key` só é
atualizado se vier preenchido (vazio = inalterado).

### Conversar com o agente (member) — a "porta" do agente

```bash
curl -sS -X POST "$BASE/v1/tenants/$TENANT/agents/$SLUG/chat" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Vocês fazem troca?", "history": []}'
```

A resposta traz o texto + metadados + **`triggers`**: eventos acionáveis para o
canal integrador reagir sem interpretar o texto livre. Cada trigger tem
`type` ∈ `{ "transbordo", "chamado_criado", "atendimento_finalizado" }`, um
`reason` legível e um `data` estruturado (payload do evento).

```jsonc
{
  "response": "Vou registrar seu chamado...",
  "should_handoff": false,
  "handoff_reason": null,
  "intent": "support",
  "source": "llm",
  "tools_called": ["create_ticket"],
  "triggers": [
    { "type": "chamado_criado",
      "reason": "Chamado #42 aberto.",
      "data": { "ticket_id": 42, "criticality": "alta", "user_name": "...", "user_email": "...", "created_at": "..." } }
  ]
}
```

- `transbordo` — derivado de `should_handoff`: sai em qualquer transbordo
  (escalonamento, limite de turnos, erro). `data` vazio; use `reason`.
- `chamado_criado` — a skill `create_ticket` abriu um chamado (`data` traz o ticket).
- `atendimento_finalizado` — a skill `finalizar_atendimento` encerrou o atendimento
  resolvido (sem transbordo).

---

## 2) Time de UX — assistente de IA + descrição das skills

### Gerar `system_prompt` + `business_rules` com IA (owner)

A partir de um **briefing** em linguagem natural, a IA rascunha as duas
configurações. É uma **sugestão**: revise e salve pelo `PUT .../config`.

```bash
curl -sS -X POST "$BASE/v1/tenants/$TENANT/assist/agent-config" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "brief": "Assistente de uma loja de roupas. Tira dúvidas sobre trocas (até 7 dias), prazos de entrega e formas de pagamento. Abre chamado quando há defeito. Tom acolhedor.",
    "agent_name": "Minha Loja",
    "tone": "cordial e objetivo",
    "skills": ["knowledge_search", "create_ticket"]
  }'
# -> { "system_prompt": "...", "business_rules": "...", "notes": "...", "tokens_used": 1234 }
```

Para **melhorar** uma config existente, envie também `current_system_prompt` e/ou
`current_business_rules`. No painel (`/`), os campos têm o botão **✨ Gerar com IA**
que faz exatamente esta chamada e preenche os campos.

> A plataforma adiciona automaticamente as instruções de segurança / anti
> prompt-injection e o tratamento de transbordo — **não** as escreva no prompt.

### Catálogo de skills com descrições (member)

A MESMA descrição que o modelo lê para decidir chamar cada skill. Útil para o time
de UX escolher quais habilitar.

```bash
curl -sS "$BASE/v1/tenants/$TENANT/skills" -H "X-API-Key: $KEY"
# -> [ { "name": "knowledge_search", "description": "...", "category": "knowledge",
#        "always_on": false, "requires": "rag" }, ... ]
```

| `requires` | Significado |
|---|---|
| `rag` | só vale com `rag_enabled: true` |
| `catalog` | só vale com `product_mode` ≠ `none` |
| `null` | sempre disponível (suporte/geral) |

---

## 3) Time de DADOS — dashboard de métricas e logs

Interface visual em **`/dashboard`** (informe a chave do tenant ou a admin + o id do
tenant). API por trás:

```bash
# Tenant inteiro, últimos 30 dias:
curl -sS "$BASE/v1/tenants/$TENANT/analytics?days=30" -H "X-API-Key: $KEY"

# Filtrando um agente e ampliando a janela:
curl -sS "$BASE/v1/tenants/$TENANT/analytics?days=90&agent=$SLUG" -H "X-API-Key: $KEY"
```

Resposta (resumida):

```jsonc
{
  "range": { "days": 30, "since": "2026-06-01T...Z", "agent_slug": null },
  "summary": {
    "total": 1280,
    "handoff_count": 192,          // transbordos (escalonou para humano)
    "success_no_handoff": 1088,
    "handoff_rate": 15.0,          // % de transbordo
    "success_rate": 85.0,          // % de sucesso sem transbordo
    "tokens_total": 845000,
    "tokens_avg": 660
  },
  "by_day":   [ { "day": "2026-06-01", "count": 40, "handoffs": 6, "tokens": 26000 } ],
  "by_intent":[ { "label": "faq", "count": 700 } ],
  "by_source":[ { "label": "llm_rag", "count": 540 } ],
  "by_agent": [ { "slug": "demo", "count": 1280, "handoffs": 192, "tokens": 845000 } ],
  "top_tools":[ { "label": "knowledge_search", "count": 610 } ],
  "recent":   [ { "id": 1, "slug": "demo", "intent": "faq", "source": "llm_rag",
                  "tokens_used": 700, "should_handoff": false, "tools_called": ["knowledge_search"],
                  "created_at": "2026-06-30T..." } ]
}
```

A telemetria é gravada a cada mensagem (tabela `interactions`) **sem PII** — só
metadados (intent, source, tokens, transbordo, skills). Veja `supabase/schema.sql`.

> Lembrete de deploy: a tabela `interactions` é nova. Em produção (Supabase), rode
> o `supabase/schema.sql` atualizado no SQL Editor (cria a tabela se faltar).
