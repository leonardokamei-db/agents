"""Ingestão de conhecimento via fila (Celery + Redis) com fallback SÍNCRONO.

Ponto 7. A ingestão de PDF/texto (extração + embeddings + escrita) é pesada e
bloqueante. Com `REDIS_URL` configurado (CELERY_ENABLED), ela é enfileirada e o
router responde 202 (`status="queued"`); um worker Celery processa em background.
Sem broker, roda síncrono no próprio processo — exatamente o comportamento atual.

Ativação (deploy fora do Railway — ver docs/DEBUG.md):
    REDIS_URL=redis://localhost:6379/0
    celery -A app.tasks.celery_app worker --loglevel=INFO

O PDF trafega como bytes (base64 quando enfileirado), então o worker não depende
de nenhum arquivo temporário local do processo web.
"""

import base64
import logging
import os
import tempfile

from app import config, rag

log = logging.getLogger("blip-agent.tasks")

celery_app = None
if config.CELERY_ENABLED:
    try:
        from celery import Celery

        celery_app = Celery("blip-agent", broker=config.REDIS_URL, backend=config.REDIS_URL)

        @celery_app.task(name="ingest_pdf")
        def _ingest_pdf_task(agent_id: str, pdf_b64: str, source_name: str) -> dict:
            return _run_pdf(agent_id, base64.b64decode(pdf_b64), source_name)

        @celery_app.task(name="ingest_text")
        def _ingest_text_task(agent_id: str, text: str, source_name: str) -> dict:
            return rag.ingest_text(agent_id, text, source_name)

        log.info("Celery habilitado (broker=%s).", config.REDIS_URL)
    except ImportError:
        log.warning("REDIS_URL setado mas 'celery' não instalado; ingestão síncrona.")
        celery_app = None


def _run_pdf(agent_id: str, pdf_bytes: bytes, source_name: str) -> dict:
    """Grava os bytes em arquivo temporário (pypdf lê de um path) e ingere."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        path = tmp.name
    try:
        return rag.ingest_pdf(agent_id, path, source_name)
    finally:
        os.unlink(path)


def submit_pdf_ingest(agent_id: str, pdf_bytes: bytes, source_name: str) -> dict:
    """Enfileira (202) se houver broker; senão ingere agora e devolve o resultado."""
    if celery_app is not None:
        task = _ingest_pdf_task.delay(agent_id, base64.b64encode(pdf_bytes).decode(), source_name)
        return {"status": "queued", "task_id": task.id, "source_name": source_name, "agent_id": agent_id}
    return _run_pdf(agent_id, pdf_bytes, source_name)


def submit_text_ingest(agent_id: str, text: str, source_name: str) -> dict:
    if celery_app is not None:
        task = _ingest_text_task.delay(agent_id, text, source_name)
        return {"status": "queued", "task_id": task.id, "source_name": source_name, "agent_id": agent_id}
    return rag.ingest_text(agent_id, text, source_name)


def is_queued(result: dict) -> bool:
    """True quando a ingestão foi enfileirada (router deve responder 202)."""
    return result.get("status") == "queued"
