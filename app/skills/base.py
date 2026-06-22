

"""Skills: a unidade de capacidade de um agente.

Uma *skill* é uma capacidade discreta e autocontida (buscar na base de
conhecimento, consultar o catálogo, reservar estoque, escalar para um humano).
Ela tem um contrato tipado e único:

    nome + descrição + modelo Pydantic de argumentos + handler -> SkillResult

Este módulo generaliza o antigo `app/tools.py`: schema (function calling do Groq)
e dispatch saem da MESMA fonte (o registry), então nunca dessincronizam.

## Por que "Skill" e não "Tool"?

O agente deixou de ser uma classe rígida por intenção (FAQ/Order/Support). Agora
ele é flexível: recebe um CONJUNTO de skills e o LLM decide qual chamar. Uma skill
é a peça que pode, no futuro, virar uma função independente (ex.: AWS Lambda).

## Fronteira desenhada para virar remota (Lambda/HTTP) depois

Hoje TUDO roda em processo (`LocalSkill`, `kind="local"`) — é o "mais simples que
Lambda" pedido. Mas o contrato já é pensado para cruzar uma fronteira de processo:

  * `SkillContext` carrega só dados serializáveis (o `AgentConfig`, que é um
    dataclass) — o que uma invocação remota precisaria enviar.
  * os argumentos são um modelo Pydantic (serializável por natureza).
  * `SkillResult` tem campos JSON-serializáveis.

Para migrar uma skill para Lambda no futuro, basta uma subclasse `RemoteSkill`
(ex.: `kind="lambda"`) cujo `invoke()` chama o backend remoto (boto3/HTTP) com o
mesmo `(ctx, args) -> SkillResult`. O registry, o loop do agente e a geração de
schema NÃO mudam — só o transporte de UMA skill.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from app.domain import AgentConfig

log = logging.getLogger("blip-agent.skills")

# Categorias de skill — usadas para derivar o conjunto default de um agente a
# partir das feature flags existentes (compatibilidade — ver enabled_skills_for).
CATEGORY_KNOWLEDGE = "knowledge"   # depende de rag_enabled
CATEGORY_CATALOG = "catalog"       # depende de product_mode != "none"
CATEGORY_SUPPORT = "support"       # sempre disponível (escalonamento)
CATEGORY_GENERAL = "general"       # sempre disponível


@dataclass(frozen=True)
class SkillContext:
    """Tudo que uma skill precisa para executar.

    Hoje carrega só o `AgentConfig`. Mantemos só dados serializáveis aqui de
    propósito: é exatamente o que uma invocação remota (Lambda/HTTP) teria de
    enviar pela rede no futuro.
    """
    agent: AgentConfig


@dataclass
class SkillResult:
    """Saída tipada e JSON-serializável de uma skill.

    `data` é o payload devolvido ao LLM (vira o conteúdo da mensagem `tool`).
    Os demais campos são SINAIS de controle que o agente interpreta fora do LLM:

      * handoff / handoff_reason  — a skill pede escalonamento humano.
      * direct_response           — resposta determinística pronta ao usuário,
                                    usada nos atalhos de 0 token (a skill é
                                    chamada FORA do loop do LLM). Ignorado quando
                                    a skill é chamada como tool pelo modelo.
      * sources                   — proveniência (ex.: fontes RAG).
    """
    data: Any = None
    handoff: bool = False
    handoff_reason: str | None = None
    direct_response: str | None = None
    sources: list[str] = field(default_factory=list)

    def tool_payload(self) -> str:
        """Serializa `data` para devolver ao LLM como resultado da tool."""
        return json.dumps(self.data, ensure_ascii=False, default=str)


class Skill(ABC):
    """Contrato de uma skill. `LocalSkill` é a implementação in-process de hoje;
    uma `RemoteSkill` futura (Lambda/HTTP) implementaria o mesmo `invoke`."""

    name: str
    description: str
    args_model: type[BaseModel]
    category: str = CATEGORY_GENERAL
    kind: str = "local"  # "local" hoje; "lambda"/"http" quando for remota

    @abstractmethod
    def invoke(self, ctx: SkillContext, args: BaseModel) -> SkillResult:
        """Executa a skill. `args` já vem validado pelo `args_model`."""
        raise NotImplementedError

    def to_tool_schema(self) -> dict:
        """Schema no formato function-calling do Groq, derivado do args_model
        (fonte única — schema e implementação nunca dessincronizam)."""
        schema = self.args_model.model_json_schema()
        schema.pop("title", None)
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": schema,
            },
        }


class LocalSkill(Skill):
    """Skill executada no próprio processo (envolve uma função Python)."""

    kind = "local"

    def __init__(self, name: str, description: str, args_model: type[BaseModel],
                 handler: Callable[[SkillContext, BaseModel], SkillResult],
                 category: str = CATEGORY_GENERAL):
        self.name = name
        self.description = description
        self.args_model = args_model
        self.category = category
        self._handler = handler

    def invoke(self, ctx: SkillContext, args: BaseModel) -> SkillResult:
        return self._handler(ctx, args)


# --- Registry --------------------------------------------------------------- #

REGISTRY: dict[str, Skill] = {}


def register(skill: Skill) -> Skill:
    """Registra uma skill já instanciada (use para skills remotas no futuro)."""
    REGISTRY[skill.name] = skill
    return skill


def skill(name: str, description: str, args_model: type[BaseModel],
          category: str = CATEGORY_GENERAL):
    """Decorator que registra uma função como `LocalSkill`. Mesma ergonomia do
    antigo `@tool`, mas o handler recebe (SkillContext, args) e devolve um
    SkillResult."""
    def decorator(fn: Callable[[SkillContext, BaseModel], SkillResult]):
        register(LocalSkill(name, description, args_model, fn, category))
        return fn
    return decorator


def get_skill(name: str) -> Skill | None:
    return REGISTRY.get(name)


def all_skill_names() -> list[str]:
    return list(REGISTRY.keys())


def tool_schemas_for(names: list[str]) -> list[dict]:
    """Schemas (function calling) das skills habilitadas, na ordem dada.
    Ignora nomes desconhecidos — a validação de nomes é do serviço de agentes."""
    return [REGISTRY[n].to_tool_schema() for n in names if n in REGISTRY]


def enabled_skills_for(agent: AgentConfig) -> list[str]:
    """Conjunto de skills de um agente.

    Se `agent.skills` é explícito, usa-o (intersectado com o registry — nomes
    obsoletos são ignorados de forma resiliente). Se vazio, DERIVA das feature
    flags atuais (compatibilidade): RAG -> skills de conhecimento; catálogo
    configurado -> skills de catálogo; escalonamento/gerais sempre presentes.
    Assim, todo agente que já existia continua funcionando sem migração de dados.
    """
    if agent.skills:
        return [n for n in agent.skills if n in REGISTRY]

    names: list[str] = []
    for name, sk in REGISTRY.items():
        if sk.category == CATEGORY_KNOWLEDGE and not agent.rag_enabled:
            continue
        if sk.category == CATEGORY_CATALOG and agent.product_mode == "none":
            continue
        names.append(name)
    return names


def invoke_skill(name: str, raw_args: dict, ctx: SkillContext) -> SkillResult:
    """Valida os args com Pydantic e despacha para a skill. Sempre devolve um
    SkillResult — erros viram `data={"error": ...}` (o LLM lê e se ajusta),
    nunca estouram para cima (espelha o antigo execute_tool)."""
    log.info("skill: %s(%s) agent=%s", name, raw_args, ctx.agent.id)
    sk = REGISTRY.get(name)
    if sk is None:
        return SkillResult(data={"error": f"Skill desconhecida: {name}"})
    try:
        args = sk.args_model.model_validate(raw_args or {})
    except ValidationError as e:
        return SkillResult(data={"error": f"Argumentos inválidos para {name}: {e.errors()}"})
    return sk.invoke(ctx, args)
