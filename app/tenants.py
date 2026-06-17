"""CRUD de agentes (tenants) — regra de negócio sobre o AgentRepository.

Criar um agente aqui é o que "cria o endpoint": as rotas usam o id como path
param (/v1/agents/{agent_id}/...), então um agente novo passa a aceitar
requisições imediatamente, sem redeploy. O SQL vive no repositório; aqui mora a
geração de id/api_key e as validações.
"""

import logging
import re
import secrets
import unicodedata

from app.domain import AgentConfig
from app.errors import ConflictError
from app.repositories import AgentRepository

log = logging.getLogger("blip-agent.tenants")

_repo = AgentRepository()


def slugify(name: str) -> str:
    decomposed = unicodedata.normalize("NFKD", name.lower())
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-") or "agente"


def create_agent(data: dict) -> AgentConfig:
    """Insere um agente novo e gera sua api_key. Retorna o registro completo."""
    agent_id = data.get("id") or slugify(data["name"])
    if _repo.exists(agent_id):
        raise ConflictError(f"Já existe um agente com id '{agent_id}'.")
    api_key = f"blip-{secrets.token_urlsafe(24)}"
    _repo.insert(agent_id, api_key, data)
    log.info("Agente criado: %s", agent_id)
    return _repo.get(agent_id)


def get_agent(agent_id: str) -> AgentConfig | None:
    return _repo.get(agent_id)


def list_agents() -> list[AgentConfig]:
    return _repo.list()


def update_agent(agent_id: str, changes: dict) -> AgentConfig | None:
    """Atualiza apenas os campos editáveis presentes em `changes`."""
    _repo.update(agent_id, changes)
    return _repo.get(agent_id)


def delete_agent(agent_id: str) -> bool:
    return _repo.delete(agent_id)
