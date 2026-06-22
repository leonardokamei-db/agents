"""Skills: capacidades discretas que um agente flexível pode invocar.

Importar este pacote popula o REGISTRY (cada submódulo registra suas skills com
`@skill`). Os consumidores (o agente, o serviço de agentes) usam a API pública
re-exportada aqui — nunca importam os submódulos diretamente.

Skills disponíveis hoje (todas `LocalSkill`, in-process):
  * knowledge_search  — busca na base de conhecimento (RAG). Era o FAQAgent.
  * check_stock / search_products / list_products / reserve_stock — catálogo.
  * check_catalog     — verifica o catálogo do cliente (skill nova).
  * escalate_to_human — handoff para atendente humano.

Para uma skill remota no futuro (AWS Lambda/HTTP), ver `base.py` (`RemoteSkill`):
a interface não muda, só o transporte.
"""

# Importa os submódulos para que os @skill rodem e preencham o REGISTRY.
from app.skills import catalog, knowledge, support  # noqa: F401
from app.skills.base import (
    REGISTRY,
    Skill,
    SkillContext,
    SkillResult,
    all_skill_names,
    enabled_skills_for,
    get_skill,
    invoke_skill,
    register,
    skill,
    tool_schemas_for,
)

__all__ = [
    "REGISTRY",
    "Skill",
    "SkillContext",
    "SkillResult",
    "all_skill_names",
    "enabled_skills_for",
    "get_skill",
    "invoke_skill",
    "register",
    "skill",
    "tool_schemas_for",
]
