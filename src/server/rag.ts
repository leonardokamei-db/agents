/**
 * Vector store RAG (porta `app/rag.py`) sobre Postgres + pgvector.
 *
 *   INGESTÃO: PDF / texto -> extrai -> chunking por seção -> embeda -> grava.
 *   CONSULTA: texto -> embeda -> KNN (L2) -> top-K chunks do agente.
 *
 * Diferente do sqlite-vec, o pgvector filtra por agent_id no WHERE e ordena por
 * distância L2 direto — sem o over-fetch x3 que o store antigo exigia.
 */

import { and, asc, count, desc, eq, l2Distance, max } from "drizzle-orm";

import * as config from "./config";
import { db } from "./db/client";
import { chunks } from "./db/schema";
import { EmbeddingError, embedDocuments, embedQuery } from "./embeddings";
import { ValidationError } from "./errors";
import { getLogger } from "./logging";

const log = getLogger("blip-agent.rag");

const MIN_CHUNK_CHARS = 50;

export interface SearchResult {
  content: string;
  source_name: string;
  chunk_index: number;
  score: number; // distância L2 (menor == mais similar)
}
export interface SourceInfo {
  source_name: string;
  chunk_count: number;
  last_updated: string;
}
export interface IngestResult {
  chunks_created: number;
  source_name: string;
  agent_id: string;
}

// --------------------------------------------------------------------------- //
// Chunking (porta fiel de split_text_into_chunks / _chunk_by_size)
// --------------------------------------------------------------------------- //

function isUpperLetter(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase() && ch === ch.toUpperCase();
}

export function splitTextIntoChunks(
  text: string,
  chunkSize: number = config.RAG_CHUNK_SIZE,
  overlap: number = config.RAG_CHUNK_OVERLAP,
): string[] {
  const charSize = chunkSize * 4;
  const veryShort = Math.floor(charSize / 20); // abaixo disso a seção é fragmento

  const lines = text.split(/\r\n|\r|\n/);
  let lastContent = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) lastContent = i;
  }

  const isTitle = (i: number): boolean => {
    const line = lines[i].trim();
    if (!(line.length >= 4 && line.length <= 60) || ".,;".includes(line[line.length - 1])) return false;
    if (/\d/.test(line) || i >= lastContent) return false;
    if (i !== 0) {
      const prev = lines[i - 1].trim();
      if (prev && !/[.!?]$/.test(prev)) return false;
    }
    let nxt = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim()) {
        nxt = lines[j].trim();
        break;
      }
    }
    if (nxt.length <= line.length) return false;
    return isUpperLetter(line[0]) || (line.toUpperCase() === line && /\p{L}/u.test(line));
  };

  const titleIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTitle(i)) titleIndices.push(i);
  }
  if (titleIndices.length < 2) return chunkBySize(text, chunkSize, overlap);

  const bounds = [...titleIndices];
  if (bounds[0] !== 0) bounds.unshift(0); // texto antes do 1º título = preâmbulo
  bounds.push(lines.length);
  const titleSet = new Set(titleIndices);

  const sections: Array<[string, string]> = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const first = bounds[k];
    const body = lines.slice(first, bounds[k + 1]).join("\n").trim();
    if (body) {
      const title = titleSet.has(first) ? lines[first].trim() : "";
      sections.push([title, body]);
    }
  }

  const out: string[] = [];
  let buffer = "";
  for (const [title, section] of sections) {
    if (section.length > charSize) {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      for (const sub of chunkBySize(section, chunkSize, overlap)) {
        out.push(sub.trimStart().startsWith(title) || !title ? sub : `${title}\n\n${sub}`);
      }
    } else if (buffer && buffer.length < veryShort && section.length < veryShort) {
      buffer = `${buffer}\n\n${section}`;
    } else {
      if (buffer) out.push(buffer);
      buffer = section;
    }
  }
  if (buffer) out.push(buffer);

  return out.map((c) => c.trim()).filter((c) => c.length > MIN_CHUNK_CHARS);
}

function chunkBySize(text: string, chunkSize: number, overlap: number): string[] {
  const charSize = chunkSize * 4;
  const charOverlap = overlap * 4;
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + charSize;
    let chunk = text.slice(start, end);
    if (end < text.length) {
      const lastPeriod = chunk.lastIndexOf(". ");
      if (lastPeriod > charSize / 2) {
        chunk = chunk.slice(0, lastPeriod + 1);
        end = start + lastPeriod + 1;
      }
    }
    out.push(chunk.trim());
    start = end - charOverlap;
  }
  return out.filter((c) => c.length > MIN_CHUNK_CHARS);
}

/**
 * Une as páginas do PDF removendo cabeçalho/rodapé repetido (linhas curtas
 * presentes em >= metade das páginas). < 3 páginas: junta direto.
 */
export function stripRepeatedPageLines(pages: string[]): string {
  const pageLines = pages.map((p) => p.split(/\r\n|\r|\n/).map((ln) => ln.trim()));
  if (pageLines.length < 3) {
    return pageLines.map((lines) => lines.join("\n")).join("\n\n").trim();
  }
  const counts = new Map<string, number>();
  for (const lines of pageLines) {
    for (const ln of new Set(lines.filter(Boolean))) {
      counts.set(ln, (counts.get(ln) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.floor(pageLines.length / 2));
  const repeated = new Set<string>();
  for (const [ln, c] of counts) {
    if (c >= threshold && ln.length <= 60) repeated.add(ln);
  }
  const cleaned = pageLines.map((lines) => lines.filter((ln) => !repeated.has(ln)).join("\n"));
  return cleaned.join("\n\n").trim();
}

// --------------------------------------------------------------------------- //
// Ingestão
// --------------------------------------------------------------------------- //

export async function ingestPdf(agentId: string, pdfBytes: Uint8Array, sourceName: string): Promise<IngestResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(pdfBytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const fullText = stripRepeatedPageLines(pages);
  if (!fullText) throw new ValidationError("Não foi possível extrair texto do PDF.");
  return ingestText(agentId, fullText, sourceName);
}

export async function ingestText(agentId: string, text: string, sourceName: string): Promise<IngestResult> {
  const chunkList = splitTextIntoChunks(text);
  if (chunkList.length === 0) {
    throw new ValidationError("O texto fornecido é curto demais para gerar chunks.");
  }

  const embeddings = await embedDocuments(chunkList); // fora da transação (rede)

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(and(eq(chunks.agentId, agentId), eq(chunks.sourceName, sourceName)));
    await tx.insert(chunks).values(
      chunkList.map((content, i) => ({
        agentId,
        sourceName,
        chunkIndex: i,
        content,
        embedding: embeddings[i],
      })),
    );
  });

  log.info(`Ingestão: ${chunkList.length} chunks (agent=${agentId}, source=${sourceName})`);
  return { chunks_created: chunkList.length, source_name: sourceName, agent_id: agentId };
}

// --------------------------------------------------------------------------- //
// Consulta e gestão de fontes
// --------------------------------------------------------------------------- //

export async function searchChunks(
  agentId: string,
  query: string,
  topK: number = config.RAG_TOP_K,
): Promise<SearchResult[]> {
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(query);
  } catch (e) {
    if (e instanceof EmbeddingError) {
      log.warn("Embedding indisponível para busca RAG:", e.message);
      return [];
    }
    throw e;
  }

  const distance = l2Distance(chunks.embedding, queryEmbedding);
  const rows = await db
    .select({
      content: chunks.content,
      sourceName: chunks.sourceName,
      chunkIndex: chunks.chunkIndex,
      score: distance,
    })
    .from(chunks)
    .where(eq(chunks.agentId, agentId))
    .orderBy(asc(distance))
    .limit(topK);

  return rows.map((r) => ({
    content: r.content,
    source_name: r.sourceName,
    chunk_index: r.chunkIndex,
    score: Number(r.score),
  }));
}

export async function listSources(agentId: string): Promise<SourceInfo[]> {
  const lastUpdated = max(chunks.createdAt);
  const rows = await db
    .select({ sourceName: chunks.sourceName, chunkCount: count(), lastUpdated })
    .from(chunks)
    .where(eq(chunks.agentId, agentId))
    .groupBy(chunks.sourceName)
    .orderBy(desc(lastUpdated));
  return rows.map((r) => ({
    source_name: r.sourceName,
    chunk_count: Number(r.chunkCount),
    last_updated: r.lastUpdated instanceof Date ? r.lastUpdated.toISOString() : String(r.lastUpdated ?? ""),
  }));
}

export async function deleteSource(agentId: string, sourceName: string): Promise<{ deleted_chunks: number; source_name: string }> {
  const deleted = await db
    .delete(chunks)
    .where(and(eq(chunks.agentId, agentId), eq(chunks.sourceName, sourceName)))
    .returning({ id: chunks.id });
  return { deleted_chunks: deleted.length, source_name: sourceName };
}

/** Remove todos os chunks do agente (usado ao excluir agente/tenant). */
export async function deleteAgentData(agentId: string): Promise<number> {
  const deleted = await db.delete(chunks).where(eq(chunks.agentId, agentId)).returning({ id: chunks.id });
  return deleted.length;
}
