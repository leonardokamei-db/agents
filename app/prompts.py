"""Construção de system prompts compactos.

Filosofia: o prompt base tem ~2 frases e cada modo adiciona 1-3 frases. As
regras de negócio do cliente entram uma única vez. Menos texto fixo == menos
tokens de entrada em TODA chamada ao Groq.
"""

HANDOFF_TOKEN = "[HANDOFF]"


def base_prompt(agent: dict) -> str:
    """Prompt base do agente. Usa o custom do cliente se definido; senão, um
    padrão mínimo. Regras de negócio são anexadas em uma linha."""
    prompt = (agent.get("system_prompt") or "").strip() or (
        f"Você é o assistente virtual de {agent['name']}. Responda em português, "
        f"de forma breve e cordial. Se não souber responder com as informações "
        f"disponíveis, comece a resposta com {HANDOFF_TOKEN}."
    )
    rules = (agent.get("business_rules") or "").strip()
    if rules:
        prompt += f"\nRegras de negócio: {rules}"
    return prompt


def faq_prompt(agent: dict, chunks: list[dict]) -> str:
    """Prompt RAG: trechos recuperados + instrução de aterramento."""
    if chunks:
        context = "\n\n".join(
            f"[{c['source_name']}] {c['content']}" for c in chunks
        )
    else:
        context = "(sem informações sobre o assunto)"
    return (
        f"{base_prompt(agent)}\n\n"
        f"Base de conhecimento:\n{context}\n\n"
        f"Responda APENAS com base nos trechos acima, usando só a parte relevante. "
        f"Se a resposta não estiver neles, comece com {HANDOFF_TOKEN}."
    )


def support_prompt(agent: dict) -> str:
    return (
        f"{base_prompt(agent)}\n"
        f"Modo suporte: reconheça o problema com empatia e resolva. Se exigir um "
        f"humano (reembolso, cancelamento, reclamação formal), comece com {HANDOFF_TOKEN}."
    )


def clarification_prompt(agent: dict) -> str:
    return (
        f"{base_prompt(agent)}\n"
        f"A intenção do cliente está ambígua. Não responda ainda: faça UMA única "
        f"pergunta curta de esclarecimento."
    )


def order_prompt(agent: dict) -> str:
    return (
        f"{base_prompt(agent)}\n"
        f"Modo pedidos: consulte catálogo, estoque e preços SEMPRE pelas ferramentas — "
        f"nunca invente dados. Uma ferramenta por vez; com os dados em mãos, responda "
        f"em texto. Use reserve_stock somente após confirmação explícita de compra."
    )
