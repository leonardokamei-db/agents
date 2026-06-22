"""Skill de suporte: escalonamento para um atendente humano.

O que era o handoff determinístico do SupportAgent virou esta skill. Ela tem dois
usos:

  * o LLM a chama quando percebe que o caso exige um humano (reclamação formal,
    pedido de reembolso/cancelamento, frustração);
  * o agente flexível a dispara DIRETO, sem LLM (0 token), quando a mensagem
    contém uma palavra-chave forte de escalonamento (ESCALATION_KEYWORDS).

Como tem `direct_response`, é uma skill TERMINAL: ao ser chamada, o agente
devolve a mensagem padrão de escalonamento e encerra o turno (não compõe mais).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.messages import ESCALATION_SUPPORT
from app.skills.base import (
    CATEGORY_SUPPORT,
    SkillContext,
    SkillResult,
    skill,
)

# Sinais de escalonamento imediato — handoff SEM chamar o LLM (0 tokens). Antes
# viviam em agents/support.py; agora pertencem à skill que faz o escalonamento.
ESCALATION_KEYWORDS = {
    "reembolso", "estornar", "estorno", "cancelar", "processar", "advogado",
    "procon", "absurdo", "inaceitavel", "processo",
}


class EscalateArgs(BaseModel):
    reason: str = Field(default="", description="Motivo breve do escalonamento.")


@skill(
    "escalate_to_human",
    "Encaminha a conversa para um atendente humano. Use quando o cliente pedir "
    "reembolso, cancelamento ou reclamação formal, ou quando a situação exigir "
    "uma pessoa.",
    EscalateArgs,
    category=CATEGORY_SUPPORT,
)
def _escalate_to_human(ctx: SkillContext, args: EscalateArgs) -> SkillResult:
    return SkillResult(
        data={"escalated": True, "reason": args.reason},
        handoff=True,
        handoff_reason=args.reason or "Escalonamento para atendente humano.",
        direct_response=ESCALATION_SUPPORT,
    )
