"""Embeddings de texto via API hospedada da Jina.

O modelo roda na infraestrutura da Jina, então o backend fica leve (sem
PyTorch). Requer JINA_API_KEY (free tier sem cartão: https://jina.ai/embeddings).

A dimensão de saída é fixada em EMBEDDING_DIM via Matryoshka (`dimensions`),
casando com o schema do sqlite-vec. Os vetores voltam L2-normalizados, então a
distância L2 do sqlite-vec é monotônica com a similaridade de cosseno.

Chamadas são síncronas (HTTP bloqueante); chamadores async usam asyncio.to_thread.
"""

import logging

import numpy as np
import requests

from app import config

log = logging.getLogger("blip-agent.embeddings")

JINA_API_URL = "https://api.jina.ai/v1/embeddings"
_TIMEOUT = 30  # segundos


class EmbeddingError(RuntimeError):
    """API da Jina inacessível ou com erro. Os chamadores degradam: a ingestão
    falha com mensagem clara e a busca retorna [] (o agente responde só com o
    prompt base em vez de derrubar a requisição)."""


def embed_documents(texts: list[str]) -> np.ndarray:
    """Embeda chunks para armazenamento (lado 'passage' da busca assimétrica)."""
    return _embed(texts, "retrieval.passage")


def embed_query(text: str) -> np.ndarray:
    """Embeda uma query de busca (lado 'query'). Retorna um único vetor."""
    return _embed([text], "retrieval.query")[0]


def _embed(texts: list[str], task: str) -> np.ndarray:
    if not config.JINA_API_KEY:
        raise EmbeddingError(
            "JINA_API_KEY não configurada. Obtenha uma chave em https://jina.ai/embeddings."
        )
    if not texts:
        return np.empty((0, config.EMBEDDING_DIM), dtype=np.float32)

    try:
        resp = requests.post(
            JINA_API_URL,
            headers={"Authorization": f"Bearer {config.JINA_API_KEY}"},
            json={
                "model": config.JINA_MODEL,
                "task": task,
                "dimensions": config.EMBEDDING_DIM,
                "normalized": True,
                "input": texts,
            },
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        raise EmbeddingError(f"Falha de conexão com a API da Jina: {e}")

    if resp.status_code == 401:
        raise EmbeddingError("JINA_API_KEY inválida (401).")
    if resp.status_code == 429:
        raise EmbeddingError("Limite de requisições da Jina atingido (429). Tente novamente em instantes.")
    if resp.status_code != 200:
        log.error("Jina API %s: %s", resp.status_code, resp.text[:500])
        raise EmbeddingError(f"Erro da API da Jina ({resp.status_code}).")

    items = resp.json().get("data", [])
    if len(items) != len(texts):
        raise EmbeddingError(f"Resposta da Jina inesperada: {len(items)} vetores para {len(texts)} textos.")
    items.sort(key=lambda it: it.get("index", 0))  # garante a ordem do input
    return np.array([it["embedding"] for it in items], dtype=np.float32)
