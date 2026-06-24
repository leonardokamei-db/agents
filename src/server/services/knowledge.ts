/**
 * KnowledgeService (porta `app/services/knowledge.py`): ingestão e gestão da base
 * RAG por agente. Aplica a feature flag `rag_enabled` e valida a entrada.
 *
 * Ingestão SÍNCRONA (decisão da migração: Celery+Redis removidos). O I/O é async
 * em Node, então a rota apenas faz `await` — sem worker thread.
 */

import type { AgentConfig } from "../domain";
import { ValidationError } from "../errors";
import * as rag from "../rag";
import type { IngestResult, SourceInfo } from "../rag";

export class KnowledgeService {
  ingestPdf(agent: AgentConfig, pdfBytes: Uint8Array, sourceName: string): Promise<IngestResult> {
    KnowledgeService.requireRag(agent);
    if (pdfBytes.length === 0) throw new ValidationError("Arquivo PDF vazio.");
    return rag.ingestPdf(agent.id, pdfBytes, sourceName);
  }

  ingestText(agent: AgentConfig, text: string, sourceName: string): Promise<IngestResult> {
    KnowledgeService.requireRag(agent);
    return rag.ingestText(agent.id, text, sourceName);
  }

  listSources(agent: AgentConfig): Promise<SourceInfo[]> {
    return rag.listSources(agent.id);
  }

  deleteSource(agent: AgentConfig, sourceName: string): Promise<{ deleted_chunks: number; source_name: string }> {
    return rag.deleteSource(agent.id, sourceName);
  }

  private static requireRag(agent: AgentConfig): void {
    if (!agent.ragEnabled) {
      throw new ValidationError(
        "Base de conhecimento desabilitada para este agente (feature flag rag_enabled=false).",
      );
    }
  }
}
