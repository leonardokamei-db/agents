/**
 * Sanitização de conteúdo NÃO confiável antes de entrar no prompt do LLM.
 *
 * Aplica-se à mensagem do usuário, ao histórico e às saídas de skills (chunks de
 * RAG, catálogo externo) — tudo que um terceiro/cliente controla. O objetivo é
 * NEUTRALIZAR vetores de prompt injection PRESERVANDO o texto legível (emojis,
 * acentos, idioma): nada de lower-case nem remoção de acento aqui (isso é o
 * `textutil.normalize`, que serve para *matching*, não para exibir/enviar texto).
 */

import { HANDOFF_TOKEN } from "../prompts";

/** Monta uma classe de caracteres `[...]` a partir de faixas de code points.
 *  Construída em runtime (via fromCharCode) para o fonte ficar 100% ASCII. */
function charClass(ranges: Array<[number, number]>): string {
  return (
    "[" +
    ranges
      .map(([a, b]) =>
        a === b ? String.fromCharCode(a) : `${String.fromCharCode(a)}-${String.fromCharCode(b)}`,
      )
      .join("") +
    "]"
  );
}

// Invisíveis e controles perigosos: controles C0/DEL (exceto \t \n \r),
// zero-width (200B-200D), word-joiner (2060), BOM/ZWNBSP (FEFF) e marcas bidi —
// override/embedding (202A-202E) e isolates (2066-2069).
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const INVISIBLE_CLASS = charClass(INVISIBLE_RANGES);

/** Há algum caractere invisível/controle/bidi perigoso no texto? (para detecção) */
export function hasInvisible(text: string): boolean {
  return new RegExp(INVISIBLE_CLASS).test(text);
}

// "HANDOFF" sem os colchetes — para reconstruir o padrão [HANDOFF] em qualquer caixa.
const HANDOFF_WORD = HANDOFF_TOKEN.slice(1, -1);
const HANDOFF_RE = new RegExp(`\\[\\s*${HANDOFF_WORD}\\s*\\]`, "gi");

/**
 * Neutraliza marcadores estruturais que um atacante usaria para forjar uma
 * fronteira de chat-template ou disparar lógica interna. Não apaga a palavra —
 * só remove os caracteres que a tornam um *token* especial — mantendo o texto
 * auditável e legível.
 *   <|im_start|>                          -> (im_start)
 *   [INST] / [/INST]                      -> (INST)
 *   <<SYS>> / <</SYS>>                     -> (SYS)
 *   <s> / </s>                            -> (s)
 *   system:/assistant: (início de linha)  -> system-/assistant-
 *   [HANDOFF] (qualquer caixa)            -> handoff  (só o LLM legítimo dispara handoff)
 */
export function stripDangerousTokens(text: string): string {
  if (!text) return text;
  return text
    .replace(/<\|([^|>\n]{0,40})\|>/g, "($1)")
    .replace(/\[\/?\s*INST\s*\]/gi, "(INST)")
    .replace(/<<\/?\s*SYS\s*>>/gi, "(SYS)")
    .replace(/<\/?s>/gi, "(s)")
    .replace(HANDOFF_RE, "handoff")
    .replace(/^[ \t]*(system|assistant)\s*:/gim, "$1-");
}

/**
 * Sanitização completa de um texto não confiável:
 *   1. NFKC — colapsa formas de compatibilidade/homoglyphs (preservando o texto).
 *   2. Remove invisíveis/controles/bidi.
 *   3. Neutraliza tokens de chat-template e o [HANDOFF].
 */
export function sanitizeUntrusted(text: string): string {
  if (!text) return text;
  const cleaned = text.normalize("NFKC").replace(new RegExp(INVISIBLE_CLASS, "g"), "");
  return stripDangerousTokens(cleaned);
}
