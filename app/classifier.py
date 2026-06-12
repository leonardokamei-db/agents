"""Classificador de intenção leve, por palavras-chave (0 tokens de LLM).

Retorna (intent, confidence) com intent em {"faq", "support", "order", "unclear"}.
"""

import logging
from typing import List, Tuple

from app.textutil import word_set

log = logging.getLogger("blip-agent.classifier")

# As chaves são sem acento — word_set normaliza diacríticos.
KEYWORDS = {
    "faq": {
        "como", "quando", "qual", "quais", "onde", "horario", "endereco",
        "funciona", "possivel", "aceita", "aceitam", "formas", "pagamento",
        "entrega", "prazo", "garantia", "agendar", "convenio", "convenios",
        "parcelamento", "parcelar", "parcela", "parcelas", "vezes", "cartao",
        "credito", "debito", "pix", "boleto", "troca", "trocar", "devolucao",
        "devolver", "rastreio", "rastreamento", "frete", "atendimento",
        "localizacao", "abre", "fecha",
    },
    # Sinais fortes de suporte — alguns também disparam o handoff determinístico
    # do SupportAgent (mantidos em sincronia lá).
    "support": {
        "problema", "erro", "quebrou", "quebrado", "atrasou", "atrasado",
        "errado", "defeito", "reclamacao", "reembolso", "cancelar", "estornar",
        "estorno", "ninguem", "demora", "ruim", "pessimo", "insatisfeito",
        "processar", "processo", "advogado", "procon", "absurdo", "inaceitavel",
        "reclamar", "frustrado", "horrivel",
    },
    # Intenção de compra/catálogo — roteada ao OrderAgent (tool use).
    "order": {
        "quero", "queria", "comprar", "compra", "pedir", "pedido", "disponivel",
        "disponiveis", "estoque", "unidade", "unidades", "produto", "produtos",
        "catalogo", "adquirir", "preco", "valor", "quanto", "custa", "modelo",
        "modelos",
    },
}

# Palavras genéricas que nunca decidem intenção sozinhas.
STOPWORDS = {"nao", "sim", "ok", "oi", "ola", "tudo", "bem"}

# Em empate de score: problemas > compra > informação.
_PRIORITY = {"support": 3, "order": 2, "faq": 1}


def classify(message: str, history: List[dict]) -> Tuple[str, float]:
    words = word_set(message) - STOPWORDS
    scores = {intent: len(words & kws) for intent, kws in KEYWORDS.items()}

    if max(scores.values()) == 0:
        intent, confidence = "unclear", 0.30
    else:
        intent = max(scores, key=lambda k: (scores[k], _PRIORITY[k]))
        confidence = min(0.65 + 0.12 * scores[intent], 0.97)

    confidence = round(confidence, 2)
    log.info("intent=%s conf=%.2f scores=%s msg=%r", intent, confidence, scores, message[:60])
    return intent, confidence
