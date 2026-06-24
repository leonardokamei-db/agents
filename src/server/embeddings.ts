/**
 * Embeddings de texto via API hospedada da Jina (porta `app/embeddings.py`).
 *
 * O modelo roda na infra da Jina, então o backend fica leve (sem PyTorch). A
 * dimensão é fixada em EMBEDDING_DIM via Matryoshka; vetores voltam
 * L2-normalizados (distância L2 monotônica com cosseno).
 *
 * Degradação: a busca RAG captura `EmbeddingError` e devolve []; a ingestão deixa
 * propagar (503 com mensagem clara).
 */

import { EMBEDDING_DIM, JINA_API_KEY, JINA_MODEL } from "./config";
import { EmbeddingUnavailableError } from "./errors";
import { getLogger } from "./logging";

const log = getLogger("blip-agent.embeddings");

const JINA_API_URL = "https://api.jina.ai/v1/embeddings";
const TIMEOUT_MS = 30_000;

/** API da Jina inacessível ou com erro (AppError 503). */
export class EmbeddingError extends EmbeddingUnavailableError {}

interface JinaItem {
  index?: number;
  embedding: number[];
}

/** Embeda chunks para armazenamento (lado 'passage' da busca assimétrica). */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "retrieval.passage");
}

/** Embeda uma query de busca (lado 'query'). Retorna um único vetor. */
export async function embedQuery(text: string): Promise<number[]> {
  const out = await embed([text], "retrieval.query");
  return out[0];
}

async function embed(texts: string[], task: string): Promise<number[][]> {
  if (!JINA_API_KEY) {
    throw new EmbeddingError(
      "JINA_API_KEY não configurada. Obtenha uma chave em https://jina.ai/embeddings.",
    );
  }
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(JINA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${JINA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JINA_MODEL,
        task,
        dimensions: EMBEDDING_DIM,
        normalized: true,
        input: texts,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new EmbeddingError(`Falha de conexão com a API da Jina: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) throw new EmbeddingError("JINA_API_KEY inválida (401).");
  if (resp.status === 429) {
    throw new EmbeddingError(
      "Limite de requisições da Jina atingido (429). Tente novamente em instantes.",
    );
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 500);
    log.error(`Jina API ${resp.status}: ${text}`);
    throw new EmbeddingError(`Erro da API da Jina (${resp.status}).`);
  }

  const payload = (await resp.json()) as { data?: JinaItem[] };
  const items = payload.data ?? [];
  if (items.length !== texts.length) {
    throw new EmbeddingError(
      `Resposta da Jina inesperada: ${items.length} vetores para ${texts.length} textos.`,
    );
  }
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)); // garante a ordem do input
  return items.map((it) => it.embedding);
}
