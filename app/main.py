"""Aplicação FastAPI: monta routers, inicializa bancos e serve o client."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app import config, tenants
from app.db import init_db
from app.rag import init_rag_db
from app.routers import admin, agent, knowledge, products

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("blip-agent")

_CLIENT_HTML = Path(__file__).resolve().parent.parent / "client.html"

_DEMO_PRODUCTS = [
    ("Smartphone Galaxy A55", "Smartphone 5G, 256GB, tela AMOLED 6.6\"", 1899.90, 12),
    ("Notebook Ideapad 3", "Notebook 15.6\", Ryzen 5, 8GB RAM, SSD 512GB", 3299.00, 5),
    ("Fone Bluetooth JBL Tune", "Fone over-ear sem fio, bateria 40h", 299.90, 2),
    ("Smart TV 50\" 4K", "Smart TV LED 50 polegadas, 4K, Wi-Fi", 2499.00, 0),
    ("Mouse Gamer RGB", "Mouse óptico 7200 DPI com iluminação RGB", 149.90, 30),
]


def _seed_demo_agent() -> None:
    """Cria um agente demo no primeiro boot com banco vazio (desligue com
    SEED_DEMO=0). Sem conteúdo RAG — suba um PDF pela UI ou API."""
    if not config.SEED_DEMO or tenants.list_agents():
        return
    from app import catalog

    demo = tenants.create_agent({
        "id": "demo",
        "name": "Loja Demo",
        "business_rules": (
            "Troca em até 7 dias com nota fiscal. Reembolso se a entrega atrasar "
            "mais de 7 dias. Para defeitos, oriente sobre a garantia antes de escalar."
        ),
        "product_mode": "internal",
    })
    for name, description, price, stock in _DEMO_PRODUCTS:
        catalog.create_product("demo", {
            "name": name, "description": description, "price": price, "stock": stock,
        })
    log.info("Agente demo criado (id=demo). api_key=%s", demo["api_key"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    init_rag_db()
    _seed_demo_agent()
    yield


app = FastAPI(title="Blip Multi-Tenant Agent", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin.router)
app.include_router(agent.router)
app.include_router(knowledge.router)
app.include_router(products.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": config.GROQ_MODEL,
        "agents": [a["id"] for a in tenants.list_agents()],
    }


@app.get("/")
def serve_client():
    """Serve o painel web (mesma origem -> sem CORS)."""
    if _CLIENT_HTML.exists():
        return FileResponse(_CLIENT_HTML)
    return {"message": "client.html não encontrado. Use a API diretamente."}
