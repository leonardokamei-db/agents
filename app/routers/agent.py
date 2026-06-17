"""Rotas de agentes, aninhadas sob o tenant (pontos 19, 8, 12).

  POST   /v1/tenants/{tenant_id}/agents                     (owner)  -> abre o endpoint
  GET    /v1/tenants/{tenant_id}/agents                     (member)
  GET    /v1/tenants/{tenant_id}/agents/{agent_slug}        (member)
  PUT    /v1/tenants/{tenant_id}/agents/{agent_slug}/config (owner)
  DELETE /v1/tenants/{tenant_id}/agents/{agent_slug}        (owner)
  POST   /v1/tenants/{tenant_id}/agents/{agent_slug}/chat   (member)

O par (tenant, slug) é resolvido contra o banco a cada requisição — agentes
recém-criados respondem imediatamente, sem redeploy.
"""

from functools import lru_cache
from typing import List

from fastapi import APIRouter, Depends

from app.domain import AgentConfig
from app.llm import get_llm
from app.orchestrator import Orchestrator
from app.routers.deps import agent_public, require_member, require_owner, resolve_agent
from app.schemas import AgentCreate, AgentPublic, AgentUpdate, ChatRequest, ChatResponse
from app.services import AgentService, get_agent_service

router = APIRouter(prefix="/v1/tenants/{tenant_id}/agents", tags=["agents"])


@lru_cache(maxsize=256)
def _orchestrator_for(agent: AgentConfig) -> Orchestrator:
    """Cacheia o Orchestrator (e seus 5 agentes) por config. AgentConfig é um
    frozen dataclass: editar a config gera uma key nova (cache invalida sozinho)
    e o LLM é o singleton de get_llm()."""
    return Orchestrator(agent, get_llm())


@router.post("", response_model=AgentPublic, status_code=201,
             dependencies=[Depends(require_owner)])
def create_agent(tenant_id: str, payload: AgentCreate,
                 agents: AgentService = Depends(get_agent_service)):
    """Cria um agente no tenant e já abre o endpoint de chat dele."""
    agent = agents.create(tenant_id, payload.model_dump())
    return AgentPublic(**agent_public(agent))


@router.get("", response_model=List[AgentPublic], dependencies=[Depends(require_member)])
def list_agents(tenant_id: str, agents: AgentService = Depends(get_agent_service)):
    return [AgentPublic(**agent_public(a)) for a in agents.list_for_tenant(tenant_id)]


@router.get("/{agent_slug}", response_model=AgentPublic, dependencies=[Depends(require_member)])
def get_agent(agent: AgentConfig = Depends(resolve_agent)):
    return AgentPublic(**agent_public(agent))


@router.put("/{agent_slug}/config", response_model=AgentPublic,
            dependencies=[Depends(require_owner)])
def update_config(payload: AgentUpdate, agent: AgentConfig = Depends(resolve_agent),
                  agents: AgentService = Depends(get_agent_service)):
    """Edita prompt, regras, turnos, fonte de produtos e feature flags."""
    updated = agents.update(agent, payload.model_dump(exclude_unset=True))
    return AgentPublic(**agent_public(updated))


@router.delete("/{agent_slug}", dependencies=[Depends(require_owner)])
def delete_agent(agent: AgentConfig = Depends(resolve_agent),
                 agents: AgentService = Depends(get_agent_service)):
    """Exclui o agente, seus produtos (cascade) e sua base de conhecimento."""
    deleted_chunks = agents.delete(agent)
    return {"deleted": agent.slug, "deleted_chunks": deleted_chunks}


@router.post("/{agent_slug}/chat", response_model=ChatResponse,
             dependencies=[Depends(require_member)])
async def chat(req: ChatRequest, agent: AgentConfig = Depends(resolve_agent)):
    """Endpoint principal de conversa do agente."""
    orchestrator = _orchestrator_for(agent)
    result = await orchestrator.process(
        message=req.message,
        history=[m.model_dump() for m in req.history],
    )
    return ChatResponse(**result)
