"""Aplicação FastAPI: monta routers, inicializa bancos e serve o client."""

import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app import config
from app.db import init_db
from app.errors import AppError
from app.logging_ctx import (
    configure_logging,
    request_id_var,
    tenant_from_path,
    tenant_id_var,
)
from app.rag import init_rag_db
from app.routers import agent, knowledge, products, tenants
from app.services import get_tenant_service

configure_logging(config.LOG_LEVEL)
log = logging.getLogger("blip-agent")

_CLIENT_HTML = Path(__file__).resolve().parent.parent / "client.html"

_DEMO_PRODUCTS = [
    ("Smartphone Galaxy A55", "Smartphone 5G, 256GB, tela AMOLED 6.6\"", 1899.90, 12),
    ("Notebook Ideapad 3", "Notebook 15.6\", Ryzen 5, 8GB RAM, SSD 512GB", 3299.00, 5),
    ("Fone Bluetooth JBL Tune", "Fone over-ear sem fio, bateria 40h", 299.90, 2),
    ("Smart TV 50\" 4K", "Smart TV LED 50 polegadas, 4K, Wi-Fi", 2499.00, 0),
    ("Mouse Gamer RGB", "Mouse óptico 7200 DPI com iluminação RGB", 149.90, 30),
]


def _bootstrap() -> None:
    """Garante o tenant `default` e, em banco vazio, semeia o agente demo
    (desligue com SEED_DEMO=0). Sem conteúdo RAG — suba um PDF pela UI/API."""
    get_tenant_service().ensure_default_tenant()

    from app.repositories import AgentRepository
    if not config.SEED_DEMO or AgentRepository().list_for_tenant(config.DEFAULT_TENANT_ID):
        return

    from app import catalog
    from app.services import get_agent_service

    demo = get_agent_service().create(config.DEFAULT_TENANT_ID, {
        "slug": "demo",
        "name": "Loja Demo",
        "business_rules": (
            "Troca em até 7 dias com nota fiscal. Reembolso se a entrega atrasar "
            "mais de 7 dias. Para defeitos, oriente sobre a garantia antes de escalar."
        ),
        "product_mode": "internal",
    })
    for name, description, price, stock in _DEMO_PRODUCTS:
        catalog.create_product(demo.id, {
            "name": name, "description": description, "price": price, "stock": stock,
        })
    log.info("Agente demo criado: tenant=%s slug=%s id=%s",
             demo.tenant_id, demo.slug, demo.id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    init_rag_db()
    _bootstrap()
    yield


app = FastAPI(title="Blip Multi-Tenant Agent", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def context_middleware(request: Request, call_next):
    """Correlação de log (ponto 9): fixa request_id + tenant nos contextvars e
    devolve o request_id no header da resposta."""
    rid = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    r_tok = request_id_var.set(rid)
    t_tok = tenant_id_var.set(tenant_from_path(request.url.path))
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response
    finally:
        request_id_var.reset(r_tok)
        tenant_id_var.reset(t_tok)


app.include_router(tenants.router)
app.include_router(agent.router)
app.include_router(knowledge.router)
app.include_router(products.router)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    """Camada única de erros: serializa qualquer AppError com seu status tipado."""
    return JSONResponse(status_code=exc.status_code, content={"code": exc.code, "detail": exc.detail})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Rede de segurança: erros não previstos viram 500 padronizado (com log)."""
    log.exception("Erro não tratado em %s: %s", request.url.path, exc)
    return JSONResponse(status_code=500, content={"code": "internal_error", "detail": "Erro interno."})


@app.get("/health")
def health():
    from app.repositories import TenantRepository
    return {
        "status": "ok",
        "model": config.GROQ_MODEL,
        "celery": config.CELERY_ENABLED,
        "tenants": [t.id for t in TenantRepository().list()],
    }


@app.get("/")
def serve_client():
    """Serve o painel web (mesma origem -> sem CORS)."""
    if _CLIENT_HTML.exists():
        return FileResponse(_CLIENT_HTML)
    return {"message": "client.html não encontrado. Use a API diretamente."}
