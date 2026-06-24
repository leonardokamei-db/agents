/**
 * Helpers de texto compartilhados (porta `app/textutil.py`).
 * Normalização sem acento + tokenização simples + slug estável.
 */

// Combining diacritical marks (U+0300..U+036F) removidas após NFKD.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Minúsculas e sem acentos/diacríticos (NFKD + remoção de combining marks). */
export function normalize(text: string): string {
  return text.toLowerCase().trim().normalize("NFKD").replace(COMBINING_MARKS, "");
}

/** Conjunto de palavras normalizadas (>= 2 chars). */
export function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalize(text).match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= 2) out.add(w);
  }
  return out;
}

/** Slug ASCII estável a partir de um nome (ids de tenant/agente). */
export function slugify(name: string, fallback = "item"): string {
  const slug = normalize(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
