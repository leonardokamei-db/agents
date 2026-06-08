# agents

Agente de IA multi-tenant (prova de conceito) construído com **FastAPI** + **Groq**.
O backend expõe uma API de chat com roteamento de intenção entre múltiplos agentes
(FAQ, Suporte, Pedidos, Clarificação, Fallback) e um pipeline **RAG** com vector
store local (`sqlite-vec`) e **embeddings hospedados na Jina** (sem PyTorch no
servidor, para caber em containers pequenos). O cliente web (`client.html`) é
servido pelo próprio servidor na rota `/`.

## Arquitetura

```
server.py        — camada FastAPI (API + serve o client.html em "/")
orchestrator.py  — roteamento de intenção + seleção de agente
classifier.py    — classificador leve de intenção
agents/          — FAQ / Suporte / Pedidos / Clarificação / Fallback
llm_client.py    — wrapper da API do Groq (LLM)
embeddings.py    — embeddings via API da Jina (substitui sentence-transformers)
database.py      — catálogo de produtos (SQLite, products.db)
rag_store.py     — vector store RAG (sqlite-vec, rag.db)
client.html      — cliente web de teste (servido em "/")
```

Os bancos SQLite (`products.db`, `rag.db`) são criados e populados automaticamente
no startup. O LLM (Groq) e os embeddings (Jina) são APIs externas — o servidor em si
é leve (~150–250 MB de RAM) e não precisa de Redis nem Docker.

> **Cliente + servidor no mesmo repositório:** o `client.html` é estático e servido
> pelo próprio FastAPI, então um único repositório e um único serviço no Railway
> atendem aos dois. Não é necessário separar em repos diferentes.

## Rodando localmente

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate    # Linux/macOS
pip install -r requirements.txt

cp .env.example .env           # e preencha GROQ_API_KEY e JINA_API_KEY
uvicorn server:app --reload --port 8000
```

Acesse http://localhost:8000 para abrir o cliente.

## Variáveis de ambiente

| Variável        | Obrigatória | Descrição                                          |
|-----------------|-------------|----------------------------------------------------|
| `GROQ_API_KEY`  | Sim         | Chave da API do Groq (LLM).                        |
| `JINA_API_KEY`  | Sim (RAG)   | Chave da API da Jina (embeddings). Free tier sem cartão. |
| `GROQ_MODEL`    | Não         | Modelo do Groq (padrão `llama-3.3-70b-versatile`). |
| `JINA_MODEL`    | Não         | Modelo de embeddings (padrão `jina-embeddings-v3`).|
| `DB_DIR`        | Não         | Diretório dos bancos SQLite. Aponte para o Volume do Railway (ex.: `/app/data`) para persistir os dados. |
| `PORT`          | Não         | Definida automaticamente pelo Railway.             |

> Sem `JINA_API_KEY` o servidor sobe normalmente, mas o RAG não embeda: a busca
> degrada para "sem resultados" (o agente responde pelo prompt base) e a ingestão
> de PDFs/textos retorna erro 503 com mensagem clara.

### Persistência no Railway (Volume)

Por padrão os bancos (`products.db`, `rag.db`) são recriados a cada deploy. Para
persistir os dados ingeridos:

1. No serviço: **Settings → Volumes → New Volume**, mount path `/app/data`.
2. Em **Variables**, defina `DB_DIR = /app/data`.

## Deploy no Railway

Veja os arquivos `Procfile`, `runtime.txt` e `railway.toml`. Passo a passo no chat
de instruções do projeto.
