"""Configuração central: variáveis de ambiente e constantes globais."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# --- LLM (Groq) ------------------------------------------------------------ #
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "512"))
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.7"))

# Economia de tokens: somente as N últimas mensagens do histórico vão ao Groq.
HISTORY_LIMIT = int(os.getenv("HISTORY_LIMIT", "5"))

# --- Embeddings (Jina) ------------------------------------------------------ #
JINA_API_KEY = os.getenv("JINA_API_KEY")
JINA_MODEL = os.getenv("JINA_MODEL", "jina-embeddings-v3")
EMBEDDING_DIM = 384

# --- RAG -------------------------------------------------------------------- #
RAG_TOP_K = int(os.getenv("RAG_TOP_K", "3"))  # menos chunks == menos tokens
RAG_CHUNK_SIZE = 500   # ~tokens por chunk (proxy chars/4)
RAG_CHUNK_OVERLAP = 50

# --- Bancos SQLite ----------------------------------------------------------- #
# No Railway, aponte DB_DIR para o Volume (ex.: /app/data) para persistir.
DB_DIR = Path(os.getenv("DB_DIR") or Path(__file__).resolve().parent.parent)
DB_DIR.mkdir(parents=True, exist_ok=True)
CORE_DB_PATH = DB_DIR / "core.db"   # agents + products
RAG_DB_PATH = DB_DIR / "rag.db"     # chunks + embeddings

# --- Administração ------------------------------------------------------------ #
# Chave usada para criar/listar/excluir agentes. Defina em produção!
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "admin-dev-key")

# Cria um agente "demo" no primeiro boot quando o banco está vazio (1 = sim).
SEED_DEMO = os.getenv("SEED_DEMO", "1") == "1"

# --- Roteamento ---------------------------------------------------------------- #
CONFIDENCE_THRESHOLD = 0.7
