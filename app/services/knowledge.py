"""KnowledgeService: ingestão e gestão da base RAG por agente (pontos 12, 7, 8).

Aplica a feature flag `rag_enabled` (ponto 8), valida a entrada e delega a
ingestão pesada ao `app.tasks` — que enfileira (Celery) ou roda síncrono.

Os métodos de ingestão são SÍNCRONOS e bloqueantes no caminho de fallback; o
router os executa em worker thread (`asyncio.to_thread`).
"""

from app import rag, tasks
from app.domain import AgentConfig
from app.errors import ValidationError


class KnowledgeService:
    def ingest_pdf(self, agent: AgentConfig, pdf_bytes: bytes, source_name: str) -> dict:
        self._require_rag(agent)
        if not pdf_bytes:
            raise ValidationError("Arquivo PDF vazio.")
        return tasks.submit_pdf_ingest(agent.id, pdf_bytes, source_name)

    def ingest_text(self, agent: AgentConfig, text: str, source_name: str) -> dict:
        self._require_rag(agent)
        return tasks.submit_text_ingest(agent.id, text, source_name)

    def list_sources(self, agent: AgentConfig) -> list[dict]:
        return rag.list_sources(agent.id)

    def delete_source(self, agent: AgentConfig, source_name: str) -> dict:
        return rag.delete_source(agent.id, source_name)

    @staticmethod
    def _require_rag(agent: AgentConfig) -> None:
        if not agent.rag_enabled:
            raise ValidationError(
                "Base de conhecimento desabilitada para este agente "
                "(feature flag rag_enabled=false)."
            )
