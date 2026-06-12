# blip-agent

Backend multi-tenant de agentes de atendimento construído com **FastAPI** + **Groq**,
com pipeline **RAG** (sqlite-vec + embeddings hospedados na Jina) e painel web de
administração servido em `/`.

Cada **agente** (tenant) é criado via API e ganha imediatamente seu próprio endpoint
de chat — sem redeploy. O cliente pode subir PDFs de FAQ, editar regras de negócio e
conectar um catálogo de produtos (interno ou via API externa própria).

## Arquitetura

```
server.py            — entrypoint (uvicorn server:app)
client.html          — painel web: criar/configurar agentes, conhecimento, produtos, chat
app/
  config.py          — env vars e constantes (HISTORY_LIMIT, RAG_TOP_K, ...)
  db.py              — SQLite core.db (tabelas agents e products)
  schemas.py         — modelos Pydantic da API
  tenants.py         — CRUD de agentes
  catalog.py         — produtos: SQLite interno OU API externa do cliente
  llm.py             — cliente Groq
  embeddings.py      — embeddings via API da Jina
  rag.py             — vector store (sqlite-vec, rag.db): ingestão + busca
  prompts.py         — system prompts compactos (economia de tokens)
  classifier.py      — classificador de intenção por palavras-chave (0 tokens)
  orchestrator.py    — roteia cada mensagem para o agente certo
  agents/            — FAQ (RAG) / Suporte / Pedidos (tool use) / Clarificação / Fallback
  routers/           — admin, chat/config, conhecimento, produtos
```

## API

### Administração (header `X-Admin-Key`)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/agents` | Cria um agente; retorna a `api_key` (exibida só aqui) e o endpoint |
| GET | `/v1/agents` | Lista agentes (inclui api_key — rota de admin) |
| GET | `/v1/agents/{id}` | Configuração de um agente |
| DELETE | `/v1/agents/{id}` | Exclui agente + produtos + base de conhecimento |

### Por agente (header `X-API-Key` = chave do agente)

| Método | Rota | Descrição |
|---|---|---|
| POST | `/v1/agents/{id}/chat` | Conversa: `{message, history}` |
| GET/PUT | `/v1/agents/{id}/config` | Ler/editar prompt, regras de negócio, fonte de produtos |
| POST | `/v1/agents/{id}/knowledge/pdf` | Upload de PDF (multipart: `source_name`, `file`) |
| POST | `/v1/agents/{id}/knowledge/text` | Ingestão de texto puro |
| GET | `/v1/agents/{id}/knowledge/sources` | Fontes indexadas |
| DELETE | `/v1/agents/{id}/knowledge/sources/{nome}` | Remove uma fonte |
| GET | `/v1/agents/{id}/products` | Lista produtos (interno ou API externa) |
| POST/PUT/DELETE | `/v1/agents/{id}/products[/{pid}]` | CRUD do catálogo interno |

### Produtos via API externa

Com `product_mode = "external"`, o backend consulta `GET {product_api_url}`
(header `Authorization: Bearer {product_api_key}`, se configurada) e espera:

```json
[{"id": 1, "name": "...", "description": "...", "price": 9.9, "stock": 3, "unit": "unidade"}]
```

(ou `{"products": [...]}`). Busca e checagem de estoque rodam no backend;
reserva de estoque em catálogo externo gera handoff para um humano.

## Economia de tokens

- Apenas as últimas `HISTORY_LIMIT` mensagens (padrão **5**) vão ao Groq.
- System prompts compactos (~2 frases de base + 1–3 por modo).
- `RAG_TOP_K` chunks por pergunta (padrão 3).
- Atalhos sem LLM: match RAG muito forte responde literal (0 tokens) e
  palavras de escalonamento de suporte fazem handoff direto (0 tokens).

## Rodando localmente

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

cp .env.example .env           # preencha GROQ_API_KEY, JINA_API_KEY e ADMIN_API_KEY
uvicorn server:app --reload --port 8000
```

Acesse http://localhost:8000, informe a `ADMIN_API_KEY` (padrão dev:
`admin-dev-key`) e conecte. No primeiro boot é criado um agente `demo`
(desligue com `SEED_DEMO=0`).

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GROQ_API_KEY` | Sim | Chave da API do Groq (LLM). |
| `JINA_API_KEY` | Sim (RAG) | Chave da API da Jina (embeddings). |
| `ADMIN_API_KEY` | Em produção | Chave de administração (padrão dev: `admin-dev-key`). |
| `GROQ_MODEL` | Não | Modelo do Groq (padrão `llama-3.3-70b-versatile`). |
| `JINA_MODEL` | Não | Modelo de embeddings (padrão `jina-embeddings-v3`). |
| `HISTORY_LIMIT` | Não | Mensagens de histórico enviadas ao LLM (padrão 5). |
| `RAG_TOP_K` | Não | Chunks RAG por pergunta (padrão 3). |
| `SEED_DEMO` | Não | `0` desativa o agente demo no primeiro boot. |
| `DB_DIR` | Não | Diretório dos SQLite (`core.db`, `rag.db`). No Railway: `/app/data`. |
| `PORT` | Não | Definida automaticamente pelo Railway. |

> Sem `JINA_API_KEY` o servidor sobe, mas o RAG degrada: busca retorna vazio e a
> ingestão responde 503 com mensagem clara.

### Persistência no Railway (Volume)

1. No serviço: **Settings → Volumes → New Volume**, mount path `/app/data`.
2. Em **Variables**, defina `DB_DIR = /app/data`.

Sem isso os bancos são recriados a cada deploy (agentes, produtos e PDFs se perdem).
