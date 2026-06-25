/**
 * Detector heurístico (determinístico, 0 token) de tentativa de prompt injection
 * na ENTRADA não confiável (mensagem do cliente e histórico).
 *
 * Não é o único portão de defesa — spotlighting + sanitização já agem sempre. O
 * detector serve para OBSERVAR (telemetria) e ENDURECER (reforço no prompt do
 * turno) e, só em casos extremos (vários sinais fortes), recomendar bloqueio.
 * Por isso a estratégia é por SCORE acumulado, não por uma única regra.
 *
 * Roda sobre duas visões do texto:
 *   - `flat`: normalizado (minúsculo, sem acento — `textutil.normalize`) e com
 *     whitespace colapsado, para casar frases em PT/EN sem depender de caixa,
 *     acento ou quebras de linha.
 *   - `raw`: o texto cru, para sinais sensíveis a caractere (tokens de template,
 *     invisíveis, homoglyphs, payloads codificados).
 */

import { normalize } from "../textutil";
import { hasInvisible } from "./sanitize";

export interface InjectionVerdict {
  /** Soma dos pesos dos sinais encontrados. */
  score: number;
  /** Rótulos dos sinais (para log/telemetria). */
  reasons: string[];
  /** >= LOW: vale logar e (se habilitado) acionar o classificador em cascata. */
  suspicious: boolean;
  /** >= HIGH: endurece o prompt do turno (reforço anti-injection). */
  flagged: boolean;
  /** >= BLOCK: sinais fortes o suficiente para encaminhar a humano. */
  block: boolean;
}

export const INJECTION_LOW = 2;
export const INJECTION_HIGH = 3;
export const INJECTION_BLOCK = 8;

// --- Frases (casadas contra `flat`: minúsculo + sem acento + 1 espaço) -------- //
// "instruções" -> "instrucoes"; "você" -> "voce"; "esqueça" -> "esqueca".
const PT_OVERRIDE =
  /(ignore|ignora|ignorar|desconsidere|desconsidera|esqueca|esquece|esquecer|apague)\b.{0,40}\b(instruc(ao|oes)|regras|comandos|orientac(ao|oes)|anteriores|acima|tudo)/;
const EN_OVERRIDE =
  /(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|all|earlier|the)\b.{0,20}(instruction|rule|prompt|message|context|guideline)/;
const PT_NEWROLE =
  /(a partir de agora|de agora em diante|agora voce).{0,30}\bvoce\b|voce agora (e|sera|vai ser)|aja como|finja (que|ser)|faca de conta/;
const EN_NEWROLE =
  /(you are now|you're now|from now on|act as|pretend to be|roleplay as|do anything now)/;
const PT_EXFIL =
  /(revele|revela|mostre|mostra|exiba|exibe|repita|repete|imprima|me diga|diga me|qual (e|seria|sao)).{0,40}(instruc(ao|oes)|prompt|prompt do sistema|system prompt|configurac(ao|oes)|regras)/;
const EN_EXFIL =
  /(reveal|show|print|repeat|tell me|give me|display|expose|leak|what is|what are).{0,40}(system prompt|prompt|instruction|rule|configuration|guideline)/;
const MODE_RE =
  /(modo|mode)\s+(desenvolvedor|developer|dev|debug|sem filtro|sem restric|jailbreak|deus|god)|developer mode|jailbreak/;

// --- Sinais sensíveis a caractere (casados contra `raw`) ---------------------- //
const TEMPLATE_RE = /<\|[^|>\n]{0,40}\|>|\[\/?\s*INST\s*\]|<<\/?\s*SYS\s*>>|<\/?s>/i;
const ROLE_LINE_RE = /^[ \t]*(system|assistant)\s*:/im;
const HANDOFF_RE = /\[\s*HANDOFF\s*\]/i;
const BASE64_RE = /[A-Za-z0-9+/]{120,}={0,2}/;
const HEX_RE = /(?:[0-9a-fA-F]{2}[\s:]?){60,}/;
// Cirílico (0400-04FF) montado em runtime para o fonte ficar ASCII.
const CYRILLIC_RE = new RegExp(`[${String.fromCharCode(0x0400)}-${String.fromCharCode(0x04ff)}]`);
const LATIN_RE = /[a-z]/i;

/** Analisa um único texto e devolve um veredito por score. */
export function detectInjection(text: string): InjectionVerdict {
  const raw = text ?? "";
  const flat = normalize(raw).replace(/\s+/g, " ");
  const reasons: string[] = [];
  let score = 0;
  const add = (weight: number, reason: string): void => {
    score += weight;
    reasons.push(reason);
  };

  if (PT_OVERRIDE.test(flat) || EN_OVERRIDE.test(flat)) add(3, "override_instructions");
  if (PT_NEWROLE.test(flat) || EN_NEWROLE.test(flat)) add(3, "role_override");
  if (PT_EXFIL.test(flat) || EN_EXFIL.test(flat)) add(3, "prompt_exfiltration");
  if (MODE_RE.test(flat)) add(2, "special_mode");
  if (TEMPLATE_RE.test(raw)) add(4, "chat_template_token");
  if (ROLE_LINE_RE.test(raw)) add(3, "fake_role_line");
  if (HANDOFF_RE.test(raw)) add(4, "handoff_token_in_input");
  if (hasInvisible(raw)) add(4, "invisible_chars");
  if (CYRILLIC_RE.test(raw) && LATIN_RE.test(raw)) add(2, "homoglyph_mix");
  if (BASE64_RE.test(raw) || HEX_RE.test(raw)) add(2, "encoded_payload");

  return verdict(score, reasons);
}

/** Veredito agregado sobre vários textos (mensagem + histórico recente).
 *  Usa o MAIOR score individual (um texto egrégio decide), unindo as razões —
 *  assim um histórico longo e legítimo não acumula score à toa. */
export function detectInjectionAcross(texts: string[]): InjectionVerdict {
  let maxScore = 0;
  const reasons = new Set<string>();
  for (const t of texts) {
    const v = detectInjection(t);
    if (v.score > maxScore) maxScore = v.score;
    for (const r of v.reasons) reasons.add(r);
  }
  return verdict(maxScore, [...reasons]);
}

function verdict(score: number, reasons: string[]): InjectionVerdict {
  return {
    score,
    reasons,
    suspicious: score >= INJECTION_LOW,
    flagged: score >= INJECTION_HIGH,
    block: score >= INJECTION_BLOCK,
  };
}
