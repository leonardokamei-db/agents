"""Shared text helpers: normalization and FAQ keyword scoring."""

import re
import unicodedata
from typing import List, Tuple

FAQ_CONTEXT_TOP_N = 3

# Generic words that appear in many FAQ questions ("como funciona...", "qual é...")
# and don't help discriminate between entries. Excluded from shortcut scoring so a
# match reflects real topical overlap, not boilerplate.
_FAQ_STOPWORDS = {
    "como", "qual", "quais", "quando", "onde", "que", "the", "de", "do", "da",
    "dos", "das", "para", "com", "sao", "sa", "um", "uma", "os", "as", "no", "na",
    "voce", "voces", "meu", "minha", "seu", "sua", "ser", "tem", "ter", "isso",
    "funciona", "funcionamento", "sobre", "por", "pelo", "pela", "ao", "aos",
}


def normalize(text: str) -> str:
    """Lowercase and strip accents/diacritics."""
    text = text.lower().strip()
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def word_set(text: str) -> set:
    """Return the set of normalized content words (length >= 2) in `text`."""
    return {w for w in re.findall(r"[a-z0-9]+", normalize(text)) if len(w) >= 2}


def score_faq(query: str, faq: List[dict]) -> List[Tuple[int, int, dict]]:
    """
    Score each FAQ entry by topical word overlap with the query.

    The query is matched against BOTH the entry's question and its answer, so a
    customer who asks with different words than the stored question (e.g.
    "parcelamento em 12 vezes" vs. "formas de pagamento") still scores a match
    via the answer text — letting the deterministic shortcut fire without an LLM.

    Generic boilerplate words ("como", "qual", "funciona"...) are excluded so the
    score reflects real topical overlap. Returns (score, index, entry) sorted by
    score descending, then original order (stable).
    """
    query_words = word_set(query) - _FAQ_STOPWORDS
    scored = []
    for i, entry in enumerate(faq):
        question_words = word_set(entry["question"]) - _FAQ_STOPWORDS
        answer_words = word_set(entry.get("answer", "")) - _FAQ_STOPWORDS
        # Question matches count double (more intentful signal than the answer).
        overlap = (2 * len(question_words & query_words)
                   + len(answer_words & query_words))
        scored.append((overlap, i, entry))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return scored


def build_faq_context(scored: List[Tuple[int, int, dict]]) -> str:
    """Render the top-N matching FAQ entries as plain-text context for the LLM."""
    top = [entry for score, _, entry in scored[:FAQ_CONTEXT_TOP_N] if score > 0]
    if not top:
        top = [entry for _, _, entry in scored[:FAQ_CONTEXT_TOP_N]]
    lines = ["Informações de referência (FAQ) que podem ajudar a responder:\n"]
    for entry in top:
        lines.append(f"P: {entry['question']}\nR: {entry['answer']}\n")
    return "\n".join(lines)
