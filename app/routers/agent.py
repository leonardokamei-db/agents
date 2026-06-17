"""Rotas por agente: chat e configuração (header X-API-Key do agente).

O {agent_id} no path é resolvido contra o banco a cada requisição — agentes
recém-criados respondem imediatamente.
"""

from functools import lru_cache

from fastapi import APIRouter, Depends

from app import tenants
from app.domain import AgentConfig
from app.llm import get_llm
from app.orchestrator import Orchestrator
from app.routers.deps import agent_public, require_agent
from app.schemas import AgentPublic, AgentUpdate, ChatRequest, ChatResponse

router = APIRouter(prefix="/v1/agents/{agent_id}", tags=["agent"])


@lru_cache(maxsize=256)
def _orchestrator_for(agent: AgentConfig) -> Orchestrator:
    """Cacheia o Orchestrator (e seus 5 agentes) por config. AgentConfig é um
    frozen dataclass, então editar a config gera uma key nova (cache invalida
    naturalmente) e o LLM é o singleton de get_llm()."""
    return Orchestrator(agent, get_llm())


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, agent: AgentConfig = Depends(require_agent)):
    """Endpoint principal de conversa do agente."""
    orchestrator = _orchestrator_for(agent)
    result = await orchestrator.process(
        message=req.message,
        history=[m.model_dump() for m in req.history],
    )
    return ChatResponse(**result)


@router.get("/config", response_model=AgentPublic)
def get_config(agent: AgentConfig = Depends(require_agent)):
    return AgentPublic(**agent_public(agent))


@router.put("/config", response_model=AgentPublic)
def update_config(payload: AgentUpdate, agent: AgentConfig = Depends(require_agent)):
    """Edita prompt, regras de negócio, limite de turnos e fonte de produtos."""
    updated = tenants.update_agent(agent.id, payload.model_dump(exclude_unset=True))
    return AgentPublic(**agent_public(updated))
