"""Base de conhecimento por agente (aninhada sob o tenant).

A ingestão (extração + embeddings + escrita) é pesada e bloqueante; roda em
worker thread (`asyncio.to_thread`) e, com Redis configurado, é enfileirada
(Celery) — o KnowledgeService decide. Quando enfileirada, respondemos 202.

A feature flag `rag_enabled` e a validação vivem no service; erros de domínio
propagam para o handler único em main.py.
"""

import asyncio

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status

from app.domain import AgentConfig
from app.errors import ValidationError
from app.routers.deps import require_member, resolve_agent
from app.schemas import TextIngest
from app.services import KnowledgeService, get_knowledge_service
from app.tasks import is_queued

router = APIRouter(
    prefix="/v1/tenants/{tenant_id}/agents/{agent_slug}/knowledge",
    tags=["knowledge"],
    dependencies=[Depends(require_member)],
)


def _status(result: dict, response: Response) -> dict:
    """202 quando a ingestão foi enfileirada; 200 quando concluída na hora."""
    if is_queued(result):
        response.status_code = status.HTTP_202_ACCEPTED
    return result


@router.post("/pdf")
async def ingest_pdf(
    response: Response,
    source_name: str = Form(...),
    file: UploadFile = File(...),
    agent: AgentConfig = Depends(resolve_agent),
    svc: KnowledgeService = Depends(get_knowledge_service),
):
    """Sobe um PDF (ex.: FAQ) e o ingere no vector store do agente. Reenviar o
    mesmo source_name substitui o conteúdo anterior."""
    if not (file.filename or "").lower().endswith(".pdf"):
        raise ValidationError("Apenas arquivos PDF são aceitos.")
    pdf_bytes = await file.read()
    result = await asyncio.to_thread(svc.ingest_pdf, agent, pdf_bytes, source_name)
    return _status(result, response)


@router.post("/text")
async def ingest_text(payload: TextIngest, response: Response,
                      agent: AgentConfig = Depends(resolve_agent),
                      svc: KnowledgeService = Depends(get_knowledge_service)):
    """Ingere texto puro (útil para testes e conteúdos curtos)."""
    result = await asyncio.to_thread(svc.ingest_text, agent, payload.text, payload.source_name)
    return _status(result, response)


@router.get("/sources")
def list_sources(agent: AgentConfig = Depends(resolve_agent),
                 svc: KnowledgeService = Depends(get_knowledge_service)):
    """Fontes ingeridas do agente, com contagem de chunks."""
    return svc.list_sources(agent)


@router.delete("/sources/{source_name}")
def delete_source(source_name: str, agent: AgentConfig = Depends(resolve_agent),
                  svc: KnowledgeService = Depends(get_knowledge_service)):
    return svc.delete_source(agent, source_name)
