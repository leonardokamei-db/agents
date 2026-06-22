"""Construção de system prompts compactos.

Filosofia: o prompt base tem ~2 frases e o agente flexível adiciona só as regras
das famílias de skill que estão habilitadas. As regras de negócio do cliente
entram uma única vez. Menos texto fixo == menos tokens de entrada em TODA
chamada ao Groq.
"""

from __future__ import annotations

from app.domain import AgentConfig

HANDOFF_TOKEN = "[HANDOFF]"

# Skills de catálogo — usado só para decidir QUAIS regras de prompt incluir.
_CATALOG_SKILLS = {"check_stock", "search_products", "list_products",
                   "reserve_stock", "check_catalog"}


def base_prompt(agent: AgentConfig) -> str:
    """Prompt base do agente. Usa o custom do cliente se definido; senão, um
    padrão mínimo. Regras de negócio são anexadas em uma linha."""
    prompt = (agent.system_prompt or "").strip() or (
        f"Você é o assistente virtual de {agent.name}. Responda em português, "
        f"de forma breve e cordial. Se não souber responder com as informações "
        f"disponíveis, comece a resposta com {HANDOFF_TOKEN}."
    )
    rules = (agent.business_rules or "").strip()
    if rules:
        prompt += f"\nRegras de negócio: {rules}"
    return prompt


def skilled_prompt(agent: AgentConfig, skill_names: list[str]) -> str:
    """Prompt do agente flexível: prompt base + instruções compactas de uso das
    skills. Cada regra só entra se a skill correspondente estiver habilitada —
    assim um agente sem catálogo não paga os tokens da regra de catálogo."""
    has = set(skill_names)
    rules: list[str] = []
    if has & _CATALOG_SKILLS:
        rules.append("para catálogo, estoque e preços consulte SEMPRE pelas "
                     "ferramentas — nunca invente dados")
    if "reserve_stock" in has:
        rules.append("use reserve_stock só após confirmação explícita de compra")
    if "knowledge_search" in has:
        rules.append("para dúvidas sobre informações/políticas do negócio, use "
                     "knowledge_search")
    if "escalate_to_human" in has:
        rules.append("se precisar de uma pessoa, use escalate_to_human")

    parts = [base_prompt(agent)]
    if rules:
        parts.append(
            "Você tem ferramentas para obter dados reais: " + "; ".join(rules) + ". "
            "Uma ferramenta por vez; com os dados em mãos, responda em texto."
        )
    return "\n".join(parts)
