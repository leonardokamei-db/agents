# agents

Agente de IA multi-tenant (prova de conceito) construído com **FastAPI** + **Groq**.
O backend expõe uma API de chat com roteamento de intenção entre múltiplos agentes
(FAQ, Suporte, Pedidos, Clarificação, Fallback) e um pipeline **RAG** local
(sqlite-vec + sentence-transformers). O cliente web (`client.html`) é servido pelo
próprio servidor na rota `/`.

## Arquitetura

```
server.py        — camada FastAPI (API + serve o client.html em "/")
orchestrator.py  — roteamento de intenção + seleção de agente
classifier.py    — classificador leve de intenção
agents/          — FAQ / Suporte / Pedidos / Clarificação / Fallback
llm_client.py    — wrapper da API do Groq
database.py      — catálogo de produtos (SQLite, products.db)
rag_store.py     — vector store RAG (sqlite-vec, rag.db)
client.html      — cliente web de teste (servido em "/")
```

Os bancos SQLite (`products.db`, `rag.db`) são criados e populados automaticamente
no startup — não há serviços externos (sem Redis, sem Docker obrigatório).

> **Cliente + servidor no mesmo repositório:** o `client.html` é estático e servido
> pelo próprio FastAPI, então um único repositório e um único serviço no Railway
> atendem aos dois. Não é necessário separar em repos diferentes.

## Rodando localmente

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate    # Linux/macOS
pip install -r requirements.txt

cp .env.example .env           # e preencha o GROQ_API_KEY
uvicorn server:app --reload --port 8000
```

Acesse http://localhost:8000 para abrir o cliente.

## Variáveis de ambiente

| Variável        | Obrigatória | Descrição                                          |
|-----------------|-------------|----------------------------------------------------|
| `GROQ_API_KEY`  | Sim         | Chave da API do Groq.                              |
| `GROQ_MODEL`    | Não         | Modelo do Groq (padrão `llama-3.3-70b-versatile`). |
| `DB_DIR`        | Não         | Diretório dos bancos SQLite. Aponte para o Volume do Railway (ex.: `/app/data`) para persistir os dados. |
| `PORT`          | Não         | Definida automaticamente pelo Railway.             |

### Persistência no Railway (Volume)

Por padrão os bancos (`products.db`, `rag.db`) são recriados a cada deploy. Para
persistir os dados ingeridos:

1. No serviço: **Settings → Volumes → New Volume**, mount path `/app/data`.
2. Em **Variables**, defina `DB_DIR = /app/data`.

## Deploy no Railway

Veja os arquivos `Procfile`, `runtime.txt` e `railway.toml`. Passo a passo no chat
de instruções do projeto.
