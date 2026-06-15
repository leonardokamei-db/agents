# Arquitetura — blip-agent

Plataforma multi-tenant de agentes de atendimento. Cada cliente (tenant) é um
**agente** com endpoint de chat próprio, base de conhecimento (RAG) própria,
regras de negócio editáveis e catálogo de produtos opcional. A proposta é
funcionar como um "mini Blip Studio": o cliente configura o agente pela
interface/API e o consome via um endpoint REST, sem precisar de um time interno
dedicado a cada bot.

- **Stack:** FastAPI (Python) · Groq (LLM) · Jina (embeddings) · SQLite + sqlite-vec (dados e vetores)
- **Deploy:** Railway (`uvicorn server:app`), bancos SQLite em volume persistente
- **Front-end:** `client.html` — painel estático servido pela própria API em `/`

---

## 1. Visão de componentes

```
                          ┌─────────────────────────────┐
   Navegador / cliente    │        client.html          │
   (painel ou integração) │  painel admin + chat de teste│
                          └──────────────┬──────────────┘
                                         │ HTTPS (REST + X-API-Key)
                          ┌──────────────▼──────────────┐
                          │           FastAPI            │  app/main.py
                          │  ┌────────────────────────┐  │
                          │  │ routers/               │  │
                          │  │  admin · agent · chat  │  │  autenticação por
                          │  │  knowledge · products  │  │  agente / admin
                          │  └───────────┬────────────┘  │
                          │              ▼               │
                          │       Orchestrator           │  classifica intenção
                          │   (roteia p/ um agente)      │  e seleciona o agente
                          │  ┌────────────────────────┐  │
                          │  │ agents/                │  │
                          │  │  faq · support · order │  │
                          │  │  clarification·fallback│  │
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

Mapa de arquivos:

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Config | `app/config.py` | Env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, modelos, paths) |
| API | `app/main.py`, `app/routers/*` | Endpoints, autenticação, CORS, ciclo de vida |
| Schemas | `app/schemas.py` | Modelos Pydantic (validação de entrada/saída) |
| Tenants | `app/tenants.py`, `app/db.py` | CRUD de agentes na tabela `agents` (SQLite) |
| Roteamento | `app/orchestrator.py`, `app/classifier.py` | Classifica intenção e escolhe o agente |
| Agentes | `app/agents/*` | Lógica de cada modo (FAQ/RAG, suporte, pedidos, ...) |
| Prompts | `app/prompts.py` | System prompts compactos por modo |
| RAG | `app/rag.py`, `app/embeddings.py` | Chunking, ingestão, busca vetorial, embeddings |
| Catálogo | `app/catalog.py`, `app/tools.py` | Produtos (SQLite interno OU API externa) + tool use |

---

## 2. Multi-tenancy: como nasce um endpoint

Um agente é uma linha na tabela `agents`. **Criar o agente já "abre" o
endpoint** — não há geração de código nem redeploy. As rotas usam o `agent_id`
como path param e o resolvem contra o banco a cada requisição:

```
POST   /v1/agents                          (admin) cria o agente → devolve api_key + endpoint
POST   /v1/agents/{id}/chat                conversa (a "porta" do agente)
GET/PUT /v1/agents/{id}/config             lê/edita prompt e regras de negócio
POST   /v1/agents/{id}/knowledge/pdf|text  sobe FAQ/documentos (RAG)
GET    /v1/agents/{id}/knowledge/sources   lista fontes indexadas
*      /v1/agents/{id}/products            CRUD do catálogo (modo interno)
```

**Autenticação em duas camadas** (`app/routers/deps.py`):
- `X-Admin-Key` — operações de plataforma (criar/listar/excluir agentes).
- `X-API-Key` — chave única por agente, gerada na criação, escopo só àquele agente.

O isolamento de dados é por `agent_id` em todas as tabelas (produtos e chunks
RAG filtram por tenant), então um agente nunca enxerga dados de outro.

---

## 3. Fluxo de uma requisição de chat

`Orchestrator.process()` (`app/orchestrator.py`):

1. **Trunca o histórico** para as últimas `HISTORY_LIMIT` mensagens (padrão **5**)
   — economia de tokens já na entrada.
2. **Classifica a intenção** (`classifier.py`): contagem de palavras-chave →
   `faq` / `support` / `order` / `unclear`, com um score de confiança.
3. **Seleciona o agente**:
   - confiança > 0.7 e intenção clara → agente correspondente;
   - senão → `clarification` (faz uma pergunta);
   - conversa acima de `max_turns` → `fallback` (handoff).
4. **Executa o agente** e anexa metadados (intent, confiança, fonte, tokens).
5. Qualquer exceção é capturada e vira um handoff gracioso (nunca derruba a request).

Agentes (`app/agents/`):

| Agente | O que faz | Custo |
|---|---|---|
| **FAQAgent** | Busca RAG; se o match for fortíssimo responde literal (0 tokens), senão injeta os chunks e o LLM compõe | 0 ou ~1 chamada |
| **OrderAgent** | Tool use (function calling) sobre o catálogo — nunca inventa preço/estoque | 1–N chamadas |
| **SupportAgent** | Empático; palavras de escalonamento ("reembolso", "cancelar"...) fazem handoff direto (0 tokens) | 0 ou 1 |
| **ClarificationAgent** | Faz UMA pergunta quando a intenção é ambígua | 1 |
| **FallbackAgent** | Handoff estático; funciona mesmo se o LLM estiver fora | 0 |

---

## 4. RAG (base de conhecimento)

`app/rag.py` + `app/embeddings.py`:

- **Ingestão:** PDF/texto → chunking por seção (um tópico por chunk; cabeçalhos
  e rodapés repetidos de PDF são removidos antes) → embedding em lote → grava em
  `rag.db` (sqlite-vec). Re-ingerir a mesma fonte substitui os chunks.
- **Busca:** pergunta → embedding → KNN por distância L2 → top-K chunks do tenant.
- **Embeddings:** API hospedada da Jina (`jina-embeddings-v3`, 384 dim,
  multilíngue, vetores L2-normalizados). Roda fora do servidor, então o backend
  fica leve (sem PyTorch).
- **Degradação graciosa:** se a Jina estiver indisponível, a busca devolve vazio
  e o agente responde pelo prompt base / faz handoff, em vez de quebrar.

Dois atalhos cortam custo de LLM a zero: match RAG muito forte responde o chunk
literal (`faq_shortcut`), e palavras de escalonamento de suporte fazem handoff
determinístico.

---

## 5. Catálogo de produtos (interno ou externo)

`app/catalog.py` abstrai a origem dos produtos por agente (`product_mode`):

- **`internal`** — tabela `products` no SQLite, gerenciada pelo painel/endpoints.
- **`external`** — o backend chama a **API REST do próprio cliente**
  (`GET product_api_url`, com `Authorization: Bearer` opcional) e espera uma
  lista JSON de produtos. Busca e checagem de estoque rodam no backend; reserva
  de estoque em catálogo externo gera handoff (a fonte da verdade é o cliente).
- **`none`** — agente sem produtos.

O OrderAgent acessa tudo isso por **tool use**: o modelo chama `check_stock`,
`search_products`, `list_products` ou `reserve_stock`, e o backend executa contra
a fonte configurada. O modelo nunca inventa preço ou estoque.

---

## 6. Modelo de dados

`core.db` (relacional):

```
agents(id PK, name, api_key UNIQUE, system_prompt, business_rules,
       max_turns, product_mode, product_api_url, product_api_key, created_at)
products(id PK, agent_id FK→agents, name, description, price, stock, unit)
```

`rag.db` (vetorial, sqlite-vec):

```
chunks(id PK, tenant_id, source_name, chunk_index, content, created_at)
chunk_embeddings(chunk_id PK, embedding FLOAT[384])   -- tabela virtual vec0
```

---

## 7. Estratégias de economia de tokens

| Estratégia | Onde | Efeito |
|---|---|---|
| Só as últimas 5 mensagens vão ao LLM | `orchestrator.py` (HISTORY_LIMIT) | corta o histórico que mais cresce |
| System prompts compactos | `prompts.py` | base de ~2 frases + 1–3 por modo |
| `RAG_TOP_K = 3` chunks/pergunta | `config.py` | menos contexto injetado |
| Atalho RAG sem LLM | `agents/faq.py` | match forte → 0 tokens |
| Handoff determinístico de suporte | `agents/support.py` | escalonamento → 0 tokens |
| Classificador por palavra-chave | `classifier.py` | roteamento sem chamar LLM |

Na avaliação (seção 8), **4 das 12 perguntas foram respondidas com 0 tokens** e
a média ficou em ~433 tokens/pergunta.

---

## 8. Resultados de avaliação

Medidos com o FAQ real da Loja Demo (6 páginas, 10 chunks). Reproduzível via
`docs/eval_harness.py`; log completo em [`eval_log.md`](eval_log.md).

**Embeddings (Jina):**
- Dimensão 384, vetores L2-normalizados (norma média 1.0000) — OK.
- Matriz pergunta × tópico: **acerto top-1 de 5/5 (100%)** com folga (diagonal
  0.55–0.81 vs. ruído < 0.41). A recuperação semântica está sólida.

**Chat (12 perguntas com gabarito):**
- Acurácia factual: **8/12 (67%)** · ~433 tokens/pergunta · 852 ms média.
- **As 4 falhas não são de RAG — são de roteamento.** A seção 4 do log força
  essas mesmas 4 perguntas pelo FAQAgent e obtém **4/4 corretas**.

**Por que falhou:** o classificador por palavra-chave desvia perguntas que são
de FAQ para os agentes errados, que não consultam a base de conhecimento:

| Pergunta | Palavra que desviou | Foi para | Resultado |
|---|---|---|---|
| "quanto tempo **demora** a entrega…" | demora | support | inventou "3 a 5 dias" (real: 2 a 4) |
| "quanto **custa** a entrega expressa?" | custa | order | handoff (resposta estava no FAQ) |
| "quanto **custa** a garantia estendida?" | custa | order | handoff (R$ 49,90 estava no FAQ) |
| "posso **cancelar** meu pedido…" | cancelar | support | handoff automático |

**Conclusão:** embeddings e RAG estão prontos; o gargalo de qualidade é o
classificador de intenção. É o item de maior impacto no roadmap (seção 9).

---

## 9. Limitações conhecidas e melhorias

**Prioridade alta**
1. **Classificador de intenção.** Palavras como "custa"/"demora"/"cancelar"
   sequestram perguntas de FAQ. Opções: (a) sempre tentar o RAG primeiro e só
   cair para os outros agentes se a recuperação for fraca; (b) trocar o
   classificador de palavra-chave por um baseado em embeddings/LLM leve;
   (c) deixar o LLM decidir a ferramenta. **Maior ganho de acurácia com menor esforço.**
2. **Anti-alucinação no OrderAgent.** No teste, "vocês vendem geladeira?" recebeu
   "Sim, vendemos" — o agente de pedidos precisa confirmar contra o catálogo
   antes de afirmar disponibilidade.

**Prioridade média**
3. **System prompt e prompt injection.** Hoje o `system_prompt` é editável pelo
   cliente e concatenado direto. Antes de expor isso amplamente, definir política
   de sanitização/limites e proteção contra injeção e jailbreak — área sensível,
   pede revisão de quem tem experiência em segurança de LLM.
4. **Observabilidade.** Os tokens já voltam por resposta, mas não são persistidos.
   Para faturar/monitorar por cliente é preciso registrar tokens, nº de chamadas
   à IA, taxa de handoff e latência por agente — alinhar com o time de dados.

**Prioridade a planejar**
5. **Escala e segurança do backend.** Rate limiting por agente, rotação de chaves,
   e SQLite → Postgres se a concorrência de escrita crescer (hoje é arquivo único).
6. **Sincronia do catálogo externo.** Cada consulta bate na API do cliente; um
   cache curto com invalidação reduziria latência e carga.

---

## 10. Como reproduzir os testes

```bash
# com GROQ_API_KEY e JINA_API_KEY no .env
PYTHONPATH=. .venv/Scripts/python.exe docs/eval_harness.py
# → escreve docs/eval_log.md (usa banco temporário, não toca os dados reais)
```
