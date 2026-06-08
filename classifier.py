"""Lightweight keyword-based intent classifier.

Returns (intent, confidence) where intent is one of "faq", "support", "order",
"unclear". Designed to be swapped for an embeddings-based classifier later.
"""

import logging
from typing import List, Tuple

from text_utils import word_set

log = logging.getLogger("blip-agent.classifier")


class IntentClassifier:
    def __init__(self, tenant_config: dict):
        self.tenant = tenant_config
        self.keywords = {
            "faq": {
                "como", "quando", "qual", "quais", "onde", "horario", "endereco",
                "preco", "custa", "valor", "funciona", "possivel", "aceita",
                "aceitam", "formas", "pagamento", "entrega", "prazo", "garantia",
                "agendar", "convenio", "convenios",
                # Common product/service terms that map to FAQ answers.
                "parcelamento", "parcelar", "parcela", "parcelas", "vezes",
                "cartao", "credito", "debito", "pix", "boleto", "troca", "trocar",
                "devolucao", "devolver", "rastreio", "rastreamento", "codigo",
                "frete", "atendimento", "localizacao", "abre", "fecha",
            },
            # Hard-escalation terms — strong support signal that also triggers
            # the SupportAgent's deterministic handoff (kept in sync with it).
            "support": {
                "problema", "erro", "quebrou", "quebrado", "atrasou", "atrasado",
                "errado", "defeito", "reclamacao", "reembolso", "cancelar",
                "estornar", "estorno", "ninguem", "demora", "ruim", "pessimo",
                "insatisfeito", "processar", "processo", "advogado", "procon",
                "absurdo", "inaceitavel", "reclamar", "frustrado", "horrivel",
            },
            # Purchase / catalog intent — routed to the OrderAgent (tool use).
            # NOTE: word_set normalizes accents, so keys here are accent-free
            # (e.g. "disponivel", "catalogo", "preco").
            "order": {
                "quero", "queria", "comprar", "compra", "pedir", "pedido",
                "disponivel", "disponiveis", "estoque", "unidade", "unidades",
                "produto", "produtos", "catalogo", "adquirir", "preco", "valor",
                "quanto", "custa", "modelo", "modelos",
            },
        }
        # Generic words that should never decide intent on their own.
        self.stopwords = {"nao", "sim", "ok", "oi", "ola", "tudo", "bem"}

    def classify(self, message: str, history: List[dict]) -> Tuple[str, float]:
        words = word_set(message) - self.stopwords
        faq_score = len(words & self.keywords["faq"])
        support_score = len(words & self.keywords["support"])
        order_score = len(words & self.keywords["order"])

        scores = {"faq": faq_score, "support": support_score, "order": order_score}

        if max(scores.values()) == 0:
            intent, confidence = "unclear", 0.30
        else:
            # Priority on ties: support (problems trump everything) > order
            # (purchase intent) > faq (generic info). Higher score still wins.
            priority = {"support": 3, "order": 2, "faq": 1}
            intent = max(scores, key=lambda k: (scores[k], priority[k]))
            confidence = min(0.65 + 0.12 * scores[intent], 0.97)

        confidence = round(confidence, 2)
        log.info("intent=%s confidence=%.2f (faq=%d support=%d order=%d) msg=%r",
                 intent, confidence, faq_score, support_score, order_score, message[:60])
        return intent, confidence
