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
  /**
   * Sinal de manipulação de ALTA confiança (redefinição de papel, exfiltração de
   * prompt, token de chat-template, role-line falsa ou [HANDOFF] no input). Aqui
   * NÃO basta endurecer o prompt — o Llama 3.3 ainda obedeceria; o orchestrator
   * responde de forma determinística, NO PAPEL, sem chamar o LLM (sem jailbreak
   * possível). Excluímos sinais ambíguos (homoglyph/base64/override sozinho).
   */
  refuse: boolean;
}

export const INJECTION_LOW = 2;
export const INJECTION_HIGH = 3;

// Sinais que, sozinhos, justificam recusa determinística (vide `refuse`).
const REFUSE_SIGNALS = new Set([
  "role_override",
  "prompt_exfiltration",
  "chat_template_token",
  "fake_role_line",
  "handoff_token_in_input",
]);

// --- Frases (casadas contra `flat`: minúsculo + sem acento + 1 espaço) -------- //
// "instruções" -> "instrucoes"; "você" -> "voce"; "esqueça" -> "esqueca".
const PT_OVERRIDE =
  /(ignore|ignora|ignorar|desconsidere|desconsidera|esqueca|esquece|esquecer|apague)\b.{0,40}\b(instruc(ao|oes)|regras|comandos|orientac(ao|oes)|anteriores|acima|tudo)/;
const EN_OVERRIDE =
  /(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|all|earlier|the)\b.{0,20}(instruction|rule|prompt|message|context|guideline)/;
// Redefinição de papel/persona/regras. Padrões escolhidos por BAIXO falso-positivo:
// frases que um cliente real praticamente nunca usa (ao contrário de "você é uma
// loja?" ou "ignora isso, quero o preço", que NÃO devem casar).
const PT_NEWROLE =
  /voce agora (e|eh|sera|vai ser|passa a ser)|a partir de agora,? (voce|ignore|esqueca|assuma|responda|aja|nao)|de agora em diante,? (voce|ignore|esqueca|assuma|responda)|aja como|finja (que|ser)|faca de conta que|assuma (o papel|a persona|que voce)|comporte-se como|responda (como se|sempre como)|seu nome (e|eh|sera|agora e|passa a ser)\b|voce se chama|voce (e|eh|sera) (um|uma|o|a) .{0,40}(chamad[oa]|de nome|cujo nome)|nova(s)? regra|regras? (obrigatoria|nova|atualizada|sao)|esqueca (sua|seu|suas|seus|as|os|que voce) (persona|papel|regras|instruc|identidade)/;
const EN_NEWROLE =
  /you are now\b|from now on|act as\b|pretend (to|you|that)|role-?play as|your name is\b|you('| a)re no longer|new (mandatory |updated )?rules?\b|assume the (role|persona)|respond as if you|forget (your|the|all) (instruction|rule|persona|identity|previous)/;
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

// --- Des-ofuscação (só para os regexes de FRASE) ----------------------------- //
// Atacante esconde o gatilho com leetspeak ("ign0re", "v0ce ag0ra") ou separando
// letras ("d.e a.g.o.r.a v.o.c.e"). Geramos VISÕES extras do `flat` e testamos os
// regexes de frase contra todas. As transformações são ESCOPADAS (só atuam onde há
// ofuscação real: dígito colado a letra; separador entre letras; runs de letras
// isoladas), então texto limpo nunca muda de veredito (0 falso-positivo no red-team).
const LEET_MAP: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };
// 8->b/9->g ficam DE FORA: apareceriam em SKUs/códigos ("ref A8") e criariam ruído.
function deLeet(s: string): string {
  return s.replace(/(?<=[a-z])[013457]|[013457](?=[a-z])/g, (d) => LEET_MAP[d] ?? d);
}
function deGap(s: string): string {
  return s
    .replace(/([a-z])[.\-_*]{1,2}(?=[a-z])/g, "$1") // "a.g.o.r.a" -> "agora"
    .replace(/\b[a-z](?: [a-z]){2,}\b/g, (m) => m.replace(/ /g, "")); // "v o c e" -> "voce" (>=3 letras)
}
const OBFUSCATED_RE = /[a-z][013457]|[013457][a-z]|[a-z][.\-_*]\s?[a-z]|\b[a-z](?: [a-z]){2,}\b/;

/** Analisa um único texto e devolve um veredito por score. */
export function detectInjection(text: string): InjectionVerdict {
  const raw = text ?? "";
  const flat = normalize(raw).replace(/\s+/g, " ");
  // Visões de frase: o `flat` e, SÓ quando há sinal de ofuscação, as versões
  // des-leetada e des-gapada. `anyPhrase` casa um regex contra qualquer visão.
  const views = OBFUSCATED_RE.test(flat) ? [flat, deLeet(flat), deGap(flat)] : [flat];
  const anyPhrase = (re: RegExp): boolean => views.some((v) => re.test(v));
  const reasons: string[] = [];
  let score = 0;
  const add = (weight: number, reason: string): void => {
    score += weight;
    reasons.push(reason);
  };

  if (anyPhrase(PT_OVERRIDE) || anyPhrase(EN_OVERRIDE)) add(3, "override_instructions");
  if (anyPhrase(PT_NEWROLE) || anyPhrase(EN_NEWROLE)) add(4, "role_override");
  if (anyPhrase(PT_EXFIL) || anyPhrase(EN_EXFIL)) add(3, "prompt_exfiltration");
  if (anyPhrase(MODE_RE)) add(2, "special_mode");
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
    refuse: reasons.some((r) => REFUSE_SIGNALS.has(r)),
  };
}
