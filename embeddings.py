"""Hosted text embeddings via the Jina AI API.

Replaces the local sentence-transformers / PyTorch stack. The embedding model runs
on Jina's infrastructure, so the backend stays light (~150-250 MB RAM instead of
~700 MB) and fits comfortably in a 1 GB container — while the Groq LLM and the
sqlite-vec vector store keep running in-process.

Requires the JINA_API_KEY environment variable. Free tier, no credit card needed:
get a key at https://jina.ai/embeddings (or https://jina.ai/api-dashboard/).

The output dimension is pinned to EMBEDDING_DIM through Jina's Matryoshka
`dimensions` option, so the sqlite-vec schema (FLOAT[384]) is unchanged. Vectors
are returned L2-normalized, so the L2 distance used by sqlite-vec stays monotonic
with cosine similarity (ordering by ascending distance == most similar first).

Calls are synchronous (blocking HTTP), matching rag_store's pattern: async callers
offload them with `asyncio.to_thread`.
"""

import logging
import os

import numpy as np
import requests

log = logging.getLogger("blip-agent.embeddings")

JINA_API_URL = "https://api.jina.ai/v1/embeddings"
# jina-embeddings-v3 is multilingual (good Portuguese) and supports Matryoshka
# dimension truncation via the `dimensions` request field.
JINA_MODEL = os.getenv("JINA_MODEL", "jina-embeddings-v3")
EMBEDDING_DIM = 384
_TIMEOUT = 30  # seconds


class EmbeddingError(RuntimeError):
    """Raised when the Jina embeddings API can't be reached or returns an error.

    The RAG callers degrade gracefully: ingestion fails with a clear message and
    search falls back to returning no chunks (the agent answers from its base
    prompt instead of crashing the request)."""


def _embed(texts: list[str], task: str) -> np.ndarray:
    """Embed a batch of texts. `task` is 'retrieval.passage' (documents) or
    'retrieval.query' (search queries) — asymmetric retrieval improves quality.

    Returns a float32 array of shape (len(texts), EMBEDDING_DIM).
    """
    api_key = os.getenv("JINA_API_KEY")
    if not api_key:
        raise EmbeddingError(
            "JINA_API_KEY não configurada. Defina a variável de ambiente com a sua "
            "chave da Jina (https://jina.ai/embeddings)."
        )
    if not texts:
        return np.empty((0, EMBEDDING_DIM), dtype=np.float32)

    try:
        resp = requests.post(
            JINA_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={
                "model": JINA_MODEL,
                "task": task,
                "dimensions": EMBEDDING_DIM,
                "normalized": True,
                "input": texts,
            },
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        log.error("Jina connection error: %s", e)
        raise EmbeddingError(f"Falha de conexão com a API da Jina: {e}")

    if resp.status_code == 401:
        raise EmbeddingError("JINA_API_KEY inválida (401). Verifique a chave da Jina.")
    if resp.status_code == 429:
        raise EmbeddingError("Limite de requisições da Jina atingido (429). Tente novamente em instantes.")
    if resp.status_code != 200:
        log.error("Jina API error %s: %s", resp.status_code, resp.text[:500])
        raise EmbeddingError(f"Erro da API da Jina ({resp.status_code}).")

    payload = resp.json()
    items = payload.get("data", [])
    if len(items) != len(texts):
        raise EmbeddingError(
            f"Resposta da Jina inesperada: {len(items)} vetores para {len(texts)} textos."
        )
    # Respect the index field so the order always matches the input order.
    items = sorted(items, key=lambda it: it.get("index", 0))
    vectors = np.array([it["embedding"] for it in items], dtype=np.float32)
    return vectors


def embed_documents(texts: list[str]) -> np.ndarray:
    """Embed chunks for storage (asymmetric 'passage' side)."""
    return _embed(texts, "retrieval.passage")


def embed_query(text: str) -> np.ndarray:
    """Embed a single search query (asymmetric 'query' side). Returns one vector."""
    return _embed([text], "retrieval.query")[0]
