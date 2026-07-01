/**
 * Repositório dos chunks RAG (vetores pgvector). Todo o SQL da tabela `chunks`
 * vive aqui — a lógica de chunking/embeddings fica em `rag.ts`, que orquestra.
 *
 * INVARIANTE DE TENANCY: todo método recebe `agentId` e SEMPRE aplica
 * `WHERE agent_id = ?` (a busca KNN inclusive), então o isolamento entre agentes
 * é garantia da classe — não disciplina do chamador.
 */

import { and, asc, count, desc, eq, l2Distance, max } from "drizzle-orm";

import { db } from "../db/client";
import { chunks } from "../db/schema";
import { toIso } from "./util";

/** Chunk recuperado por busca (distância L2: menor == mais similar). */
export interface ChunkMatch {
  content: string;
  sourceName: string;
  chunkIndex: number;
  score: number;
}

/** Agregado por fonte (para listar o que está indexado). */
export interface ChunkSource {
  sourceName: string;
  chunkCount: number;
  lastUpdated: string;
}

/** Chunk pronto para persistir (embedding já calculado). */
export interface NewChunk {
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export class ChunkRepository {
  /**
   * Substitui atomicamente todos os chunks de uma fonte do agente (delete + insert
   * na mesma transação). Re-ingerir a mesma `sourceName` troca o conteúdo.
   */
  async replaceSource(agentId: string, sourceName: string, rows: NewChunk[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(chunks).where(and(eq(chunks.agentId, agentId), eq(chunks.sourceName, sourceName)));
      await tx.insert(chunks).values(
        rows.map((c) => ({
          agentId,
          sourceName,
          chunkIndex: c.chunkIndex,
          content: c.content,
          embedding: c.embedding,
        })),
      );
    });
  }

  /** KNN por distância L2 (pgvector `<->`), escopado ao agente, top-K. */
  async search(agentId: string, embedding: number[], topK: number): Promise<ChunkMatch[]> {
    const distance = l2Distance(chunks.embedding, embedding);
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
      sourceName: r.sourceName,
      chunkIndex: r.chunkIndex,
      score: Number(r.score),
    }));
  }

  /** Fontes indexadas do agente, com contagem de chunks e última atualização. */
  async listSources(agentId: string): Promise<ChunkSource[]> {
    const lastUpdated = max(chunks.createdAt);
    const rows = await db
      .select({ sourceName: chunks.sourceName, chunkCount: count(), lastUpdated })
      .from(chunks)
      .where(eq(chunks.agentId, agentId))
      .groupBy(chunks.sourceName)
      .orderBy(desc(lastUpdated));
    return rows.map((r) => ({
      sourceName: r.sourceName,
      chunkCount: Number(r.chunkCount),
      lastUpdated: toIso(r.lastUpdated),
    }));
  }

  /** Remove os chunks de uma fonte do agente. Retorna quantos foram apagados. */
  async deleteSource(agentId: string, sourceName: string): Promise<number> {
    const deleted = await db
      .delete(chunks)
      .where(and(eq(chunks.agentId, agentId), eq(chunks.sourceName, sourceName)))
      .returning({ id: chunks.id });
    return deleted.length;
  }

  /** Remove TODOS os chunks do agente (ao excluir agente/tenant). */
  async deleteAll(agentId: string): Promise<number> {
    const deleted = await db.delete(chunks).where(eq(chunks.agentId, agentId)).returning({ id: chunks.id });
    return deleted.length;
  }
}
