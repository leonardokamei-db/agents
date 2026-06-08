"""
Blip multi-tenant AI agent — localhost proof-of-concept.

Thin FastAPI layer. All the brains live in:
  - orchestrator.py  — intent routing + agent selection
  - classifier.py    — lightweight intent classifier
  - agents/          — FAQ / Support / Clarification / Fallback / Order agents
  - llm_client.py    — Groq API wrapper
  - database.py      — SQLite product catalog
  - rag_store.py     — RAG vector store (sqlite-vec) for FAQ/document Q&A

State lives in two single-file SQLite databases (products.db, rag.db) next to the
code — no external services, no Redis, no Docker.
"""

import asyncio
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import list_products, seed_database
from embeddings import EmbeddingError
from llm_client import GroqLLMClient
from orchestrator import Orchestrator
from rag_store import (
    delete_source,
    ingest_pdf,
    ingest_text,
    init_rag_db,
    list_sources,
)

# --------------------------------------------------------------------------- #
# Setup
# --------------------------------------------------------------------------- #

load_dotenv()  # reads GROQ_API_KEY (and optional GROQ_MODEL) from .env

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("blip-agent")

# --------------------------------------------------------------------------- #
# Tenant configuration (hardcoded for the POC)
# --------------------------------------------------------------------------- #

TENANTS = {
    "loja_demo": {
        "id": "loja_demo",
        "name": "Loja Demo",
        "api_key": "key-loja-123",
        "max_turns": 15,  # force handoff after N history entries
        "system_prompt": (
            "Você é um assistente virtual da Loja Demo, uma loja de eletrônicos. "
            "Seja simpático e objetivo. Responda sempre em português. Se não souber "
            "responder com base nas informações disponíveis, escreva [HANDOFF] no "
            "início da resposta."
        ),
        "support_guidelines": (
            "Seja empático com problemas de entrega. Ofereça reembolso se o atraso for "
            "maior que 7 dias. Para defeitos, oriente sobre a garantia antes de escalar."
        ),
        "customer_notes": "Cliente sem histórico relevante de compras recentes.",
        "faq": [
            {
                "question": "Qual é o horário de funcionamento da loja?",
                "answer": (
                    "A Loja Demo funciona de segunda a sexta das 9h às 18h e aos "
                    "sábados das 9h às 13h. Não abrimos aos domingos e feriados."
                ),
            },
            {
                "question": "Como funciona a política de troca de produtos?",
                "answer": (
                    "Você pode trocar produtos em até 7 dias corridos após o "
                    "recebimento, desde que estejam sem uso e na embalagem original. "
                    "Basta apresentar a nota fiscal."
                ),
            },
            {
                "question": "Quais são as formas de pagamento aceitas?",
                "answer": (
                    "Aceitamos cartões de crédito e débito, Pix, boleto bancário e "
                    "parcelamento em até 12x sem juros no cartão de crédito."
                ),
            },
            {
                "question": "Qual é o prazo de entrega dos pedidos?",
                "answer": (
                    "O prazo de entrega varia de 3 a 10 dias úteis conforme a região. "
                    "Você recebe o código de rastreio por e-mail assim que o pedido é "
                    "despachado."
                ),
            },
            {
                "question": "Como funciona a garantia dos produtos?",
                "answer": (
                    "Todos os produtos têm garantia legal de 90 dias, além da garantia "
                    "do fabricante indicada na embalagem. Guarde a nota fiscal para "
                    "acionar a garantia."
                ),
            },
        ],
    },
    "clinica_demo": {
        "id": "clinica_demo",
        "name": "Clínica Demo",
        "api_key": "key-clinica-456",
        "max_turns": 12,
        "system_prompt": (
            "Você é um assistente virtual da Clínica Demo. Seja acolhedor e "
            "profissional. Responda sempre em português. Para dúvidas médicas "
            "específicas ou urgências, escreva [HANDOFF] no início da resposta."
        ),
        "support_guidelines": (
            "Seja acolhedor com pacientes ansiosos. Nunca dê diagnósticos ou "
            "orientações clínicas — encaminhe para um profissional de saúde."
        ),
        "customer_notes": "Paciente sem agendamentos em aberto.",
        "faq": [
            {
                "question": "Qual é o horário de atendimento da clínica?",
                "answer": (
                    "A Clínica Demo atende de segunda a sexta das 8h às 19h e aos "
                    "sábados das 8h às 12h."
                ),
            },
            {
                "question": "Como faço para agendar uma consulta?",
                "answer": (
                    "Você pode agendar uma consulta pelo telefone (11) 4000-0000, pelo "
                    "nosso site ou aqui mesmo pelo chat, informando a especialidade e "
                    "o período de preferência."
                ),
            },
            {
                "question": "Quais convênios são aceitos?",
                "answer": (
                    "Atendemos os convênios Unimed, Bradesco Saúde, SulAmérica e Amil, "
                    "além de consultas particulares."
                ),
            },
            {
                "question": "Como posso cancelar um agendamento?",
                "answer": (
                    "Para cancelar um agendamento, entre em contato com pelo menos 24 "
                    "horas de antecedência pelo telefone (11) 4000-0000 ou pelo chat, "
                    "informando seu nome e a data da consulta."
                ),
            },
            {
                "question": "Qual é o endereço e a localização da clínica?",
                "answer": (
                    "Estamos na Av. Exemplo, 1234 - Centro, São Paulo/SP. Ficamos a "
                    "duas quadras da estação de metrô e contamos com estacionamento "
                    "no local."
                ),
            },
        ],
    },
}

# --------------------------------------------------------------------------- #
# API models
# --------------------------------------------------------------------------- #


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    tenant_id: str
    conversation_id: str
    message: str
    history: List[Message] = []


class ChatResponse(BaseModel):
    response: str
    should_handoff: bool
    handoff_reason: Optional[str] = None
    intent: str
    agent_used: str
    source: str  # faq_shortcut | llm | support_escalation | fallback | error
    confidence: Optional[float] = None
    tokens_used: int = 0
    tools_called: List[str] = []  # tools invoked by the OrderAgent, if any
    rag_chunks_used: int = 0  # FAQ/RAG: number of retrieved chunks injected into the prompt
    rag_sources: List[str] = []  # FAQ/RAG: which sources those chunks came from
    error: Optional[str] = None


class ProductInfo(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    price: float
    stock: int
    unit: str


class TenantInfo(BaseModel):
    id: str
    name: str


# --------------------------------------------------------------------------- #
# FastAPI app
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create the schema + seed the demo catalog once on startup.
    seed_database()
    # Initialize the RAG vector store and seed demo FAQ content for the demo tenants.
    init_rag_db()
    _seed_demo_rag_content()
    yield


app = FastAPI(title="Blip Multi-Tenant Agent", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialized once at startup; orchestrators are cached per tenant.
llm_client = GroqLLMClient()
orchestrators: dict[str, Orchestrator] = {}


def _authenticate(tenant_id: str, x_api_key: Optional[str]) -> dict:
    tenant = TENANTS.get(tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail=f"Tenant '{tenant_id}' não encontrado.")
    if not x_api_key or x_api_key != tenant["api_key"]:
        raise HTTPException(status_code=401, detail="API key inválida para este tenant.")
    return tenant


def _get_orchestrator(tenant_id: str, tenant_config: dict) -> Orchestrator:
    if tenant_id not in orchestrators:
        orchestrators[tenant_id] = Orchestrator(tenant_config, llm_client)
    return orchestrators[tenant_id]


@app.get("/health")
def health():
    return {"status": "ok", "model": llm_client.model, "tenants": list(TENANTS.keys())}


@app.get("/tenants", response_model=List[TenantInfo])
def list_tenants():
    """Public list of tenants for the UI (api keys are never exposed)."""
    return [TenantInfo(id=tid, name=cfg["name"]) for tid, cfg in TENANTS.items()]


@app.get("/products/{tenant_id}", response_model=List[ProductInfo])
def get_products(tenant_id: str):
    """Inspect a tenant's catalog with current stock — used by the test client."""
    if tenant_id not in TENANTS:
        raise HTTPException(status_code=404, detail=f"Tenant '{tenant_id}' não encontrado.")
    return list_products(tenant_id)


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")):
    tenant = _authenticate(req.tenant_id, x_api_key)
    orchestrator = _get_orchestrator(req.tenant_id, tenant)

    result = await orchestrator.process(
        message=req.message,
        history=[m.model_dump() for m in req.history],
    )
    return ChatResponse(**result)


# --------------------------------------------------------------------------- #
# RAG knowledge base — PDF/text ingestion + source management.
# Embedding (Jina API call) + chunking + SQLite I/O are blocking, so they run in a
# worker thread to keep the event loop responsive — same pattern as the LLM.
# --------------------------------------------------------------------------- #


@app.post("/v1/ingest/pdf")
async def ingest_pdf_endpoint(
    tenant_id: str = Form(...),
    source_name: str = Form(...),
    file: UploadFile = File(...),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    """Upload a PDF and ingest it into the vector store for a tenant."""
    _authenticate(tenant_id, x_api_key)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Apenas arquivos PDF são aceitos.")

    # Persist to a temp file, then ingest (pypdf reads from a path).
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        result = await asyncio.to_thread(ingest_pdf, tenant_id, tmp_path, source_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except EmbeddingError as e:
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        os.unlink(tmp_path)
    return result


@app.post("/v1/ingest/text")
async def ingest_text_endpoint(
    payload: dict, x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")
):
    """Ingest raw text (useful for testing without a real PDF)."""
    tenant_id = payload.get("tenant_id")
    _authenticate(tenant_id, x_api_key)
    try:
        text = payload["text"]
        source_name = payload["source_name"]
    except KeyError as e:
        raise HTTPException(status_code=422, detail=f"Campo obrigatório ausente: {e}")
    try:
        return await asyncio.to_thread(ingest_text, tenant_id, text, source_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except EmbeddingError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/v1/sources/{tenant_id}")
async def get_sources(tenant_id: str, x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")):
    """List all ingested sources for a tenant with chunk counts."""
    _authenticate(tenant_id, x_api_key)
    return list_sources(tenant_id)


@app.delete("/v1/sources/{tenant_id}/{source_name}")
async def remove_source(
    tenant_id: str, source_name: str,
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
):
    """Delete all chunks for a given source."""
    _authenticate(tenant_id, x_api_key)
    return delete_source(tenant_id, source_name)


# Sample FAQ knowledge base text seeded for the demo tenants on first startup.
_DEMO_RAG_CONTENT = {
    "loja_demo": ("faq_loja", """
        Política de trocas e devoluções da Loja Demo:
        O cliente tem até 7 dias corridos após o recebimento para solicitar troca ou devolução de qualquer produto,
        desde que esteja na embalagem original e sem sinais de uso. Para produtos com defeito, o prazo é de 30 dias
        para produtos não duráveis e 90 dias para duráveis. A devolução é feita via correios com frete por conta
        da loja nos casos de defeito ou erro no envio.

        Formas de pagamento aceitas:
        Aceitamos cartões de crédito Visa, Mastercard, Elo e American Express em até 12x sem juros para compras
        acima de R$ 300. Débito à vista, PIX com 5% de desconto, e boleto bancário com vencimento em 3 dias úteis.

        Prazos de entrega:
        Capitais e regiões metropolitanas: 2 a 4 dias úteis.
        Interior: 5 a 10 dias úteis.
        Norte e Nordeste: 7 a 15 dias úteis.
        Retirada na loja disponível em até 2 horas após confirmação do pagamento.

        Garantia dos produtos:
        Todos os produtos eletrônicos possuem garantia mínima de 12 meses contra defeitos de fabricação.
        Garantia estendida de 24 meses disponível por R$ 49,90 para produtos acima de R$ 500.
        A garantia não cobre danos físicos, líquidos ou mau uso.

        Horário de funcionamento:
        Loja física: segunda a sexta das 9h às 18h, sábados das 10h às 14h.
        Loja online e atendimento: segunda a sexta das 8h às 20h, sábados das 9h às 16h.
    """),
    "clinica_demo": ("faq_clinica", """
        Agendamento de consultas:
        Consultas podem ser agendadas pelo telefone, WhatsApp ou diretamente pelo site.
        O agendamento online está disponível 24 horas. Confirmação enviada por SMS e e-mail.
        Para consultas de urgência no mesmo dia, ligue até as 10h.

        Convênios aceitos:
        Unimed, Bradesco Saúde, Amil, SulAmérica, Hapvida, NotreDame Intermédica, Porto Seguro Saúde.
        Convênios não listados podem ser atendidos mediante consulta prévia com a recepção.
        Consultas particulares com desconto de 15% para pagamento via PIX.

        Cancelamento e reagendamento:
        Cancelamentos devem ser feitos com no mínimo 24 horas de antecedência para evitar cobrança de taxa.
        Reagendamento gratuito e ilimitado dentro do prazo de 24 horas.
        Falta sem aviso gera cobrança de 50% do valor da consulta.

        Localização e estacionamento:
        Endereço: Av. Principal, 1234, Centro — próximo ao metrô Consolação.
        Estacionamento próprio com as 2 primeiras horas gratuitas para pacientes.
        Acessível para cadeirantes com entrada pela rua lateral.

        Horário de atendimento:
        Segunda a sexta: 7h às 19h.
        Sábados: 8h às 12h.
        Pronto-atendimento disponível 24h para casos de urgência.
    """),
}


def _seed_demo_rag_content() -> None:
    """Ingest sample FAQ text for the demo tenants on first startup (idempotent).

    Best-effort: a failure here (e.g. the embedding model can't be downloaded
    offline) is logged but must not prevent the server from starting.
    """
    for tenant_id, (source_name, text) in _DEMO_RAG_CONTENT.items():
        try:
            if source_name in {s["source_name"] for s in list_sources(tenant_id)}:
                continue
            result = ingest_text(tenant_id, text, source_name)
            log.info("Seeded RAG content for %s: %d chunks.", tenant_id, result["chunks_created"])
        except Exception as e:  # noqa: BLE001 — seeding must not brick startup.
            log.warning("Could not seed RAG content for %s: %s", tenant_id, e)


# --------------------------------------------------------------------------- #
# Optionally serve the test client at "/" so there are no CORS concerns.
# --------------------------------------------------------------------------- #

_CLIENT_HTML = Path(__file__).parent / "client.html"


@app.get("/")
def serve_client():
    if _CLIENT_HTML.exists():
        return FileResponse(_CLIENT_HTML)
    return {"message": "client.html not found next to server.py. Use the API directly."}
