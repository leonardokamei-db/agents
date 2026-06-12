"""Administração de agentes (header X-Admin-Key).

Criar um agente aqui automaticamente "abre" o endpoint dele: as rotas por
agente usam {agent_id} como path param, então /v1/agents/{novo-id}/chat passa
a aceitar requisições no mesmo instante, sem redeploy.
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException

from app import rag, tenants
from app.routers.deps import agent_public, require_admin
from app.schemas import AgentCreate, AgentCreated, AgentPublic

router = APIRouter(prefix="/v1/agents", tags=["admin"], dependencies=[Depends(require_admin)])


@router.post("", response_model=AgentCreated, status_code=201)
def create_agent(payload: AgentCreate):
    """Cria um agente e retorna a api_key gerada (exibida apenas aqui)."""
    try:
        agent = tenants.create_agent(payload.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return AgentCreated(**agent_public(agent), api_key=agent["api_key"])


@router.get("", response_model=List[AgentCreated])
def list_agents():
    """Lista todos os agentes (inclui api_key — rota exclusiva de admin)."""
    return [AgentCreated(**agent_public(a), api_key=a["api_key"]) for a in tenants.list_agents()]


@router.get("/{agent_id}", response_model=AgentPublic)
def get_agent(agent_id: str):
    agent = tenants.get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agente '{agent_id}' não encontrado.")
    return AgentPublic(**agent_public(agent))


@router.delete("/{agent_id}")
def delete_agent(agent_id: str):
    """Exclui o agente, seus produtos (cascade) e sua base de conhecimento."""
    if not tenants.delete_agent(agent_id):
        raise HTTPException(status_code=404, detail=f"Agente '{agent_id}' não encontrado.")
    deleted_chunks = rag.delete_agent_data(agent_id)
    return {"deleted": agent_id, "deleted_chunks": deleted_chunks}
