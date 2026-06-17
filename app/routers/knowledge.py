"""Base de conhecimento por agente: upload de PDFs/texto e gestão de fontes.

Embeddings (HTTP Jina) + chunking + SQLite são bloqueantes; rodam em worker
thread (`asyncio.to_thread`) para não travar o event loop.

Erros de domínio (ValidationError de texto curto, EmbeddingError 503) propagam
para o handler único em main.py — sem try/except repetido por endpoint.
"""

import asyncio
import os
import tempfile

from fastapi import APIRouter, Depends, File, Form, UploadFile

from app import rag
from app.domain import AgentConfig
from app.errors import ValidationError
from app.routers.deps import require_agent
from app.schemas import TextIngest

router = APIRouter(prefix="/v1/agents/{agent_id}/knowledge", tags=["knowledge"])


@router.post("/pdf")
async def ingest_pdf(
    source_name: str = Form(...),
    file: UploadFile = File(...),
    agent: AgentConfig = Depends(require_agent),
):
    """Faz upload de um PDF (ex.: FAQ) e o ingere no vector store do agente.
    Reenviar o mesmo source_name substitui o conteúdo anterior."""
    if not (file.filename or "").lower().endswith(".pdf"):
        raise ValidationError("Apenas arquivos PDF são aceitos.")

    # Persiste em arquivo temporário: o pypdf lê de um path.
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        return await asyncio.to_thread(rag.ingest_pdf, agent.id, tmp_path, source_name)
    finally:
        os.unlink(tmp_path)


@router.post("/text")
async def ingest_text(payload: TextIngest, agent: AgentConfig = Depends(require_agent)):
    """Ingere texto puro (útil para testes e conteúdos curtos)."""
    return await asyncio.to_thread(rag.ingest_text, agent.id, payload.text, payload.source_name)


@router.get("/sources")
def list_sources(agent: AgentConfig = Depends(require_agent)):
    """Fontes ingeridas do agente, com contagem de chunks."""
    return rag.list_sources(agent.id)


@router.delete("/sources/{source_name}")
def delete_source(source_name: str, agent: AgentConfig = Depends(require_agent)):
    return rag.delete_source(agent.id, source_name)
