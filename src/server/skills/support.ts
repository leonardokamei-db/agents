/**
 * Skill de suporte: escalonamento para um atendente humano (porta
 * `app/skills/support.py`). Skill TERMINAL: tem `directResponse`, então ao ser
 * chamada o agente devolve a mensagem padrão e encerra o turno.
 */

import { z } from "zod";

import { ESCALATION_SUPPORT } from "../messages";
import { CATEGORY_SUPPORT, registerLocal, SkillResult } from "./base";

// Sinais de escalonamento imediato — handoff SEM LLM (0 tokens). Já normalizados
// (sem acento), pois são comparados contra wordSet() do usuário.
export const ESCALATION_KEYWORDS = new Set([
  "reembolso",
  "estornar",
  "estorno",
  "cancelar",
  "processar",
  "advogado",
  "procon",
  "absurdo",
  "inaceitavel",
  "processo",
]);

const escalateArgs = z.object({
  reason: z.string().default("").describe("Motivo breve do escalonamento."),
});

registerLocal(
  "escalate_to_human",
  "Encaminha a conversa para um atendente humano. Use quando o cliente pedir " +
    "reembolso, cancelamento ou reclamação formal, ou quando a situação exigir " +
    "uma pessoa.",
  escalateArgs,
  (_ctx, args) =>
    new SkillResult({
      data: { escalated: true, reason: args.reason },
      handoff: true,
      handoffReason: args.reason || "Escalonamento para atendente humano.",
      directResponse: ESCALATION_SUPPORT,
    }),
  CATEGORY_SUPPORT,
);
