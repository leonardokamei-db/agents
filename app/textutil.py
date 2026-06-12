"""Helpers de texto compartilhados (normalização e tokenização simples)."""

import re
import unicodedata


def normalize(text: str) -> str:
    """Minúsculas e sem acentos/diacríticos."""
    decomposed = unicodedata.normalize("NFKD", text.lower().strip())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def word_set(text: str) -> set[str]:
    """Conjunto de palavras normalizadas (>= 2 chars) do texto."""
    return {w for w in re.findall(r"[a-z0-9]+", normalize(text)) if len(w) >= 2}
