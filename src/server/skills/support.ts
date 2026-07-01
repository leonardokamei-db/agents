/**
 * Skill de suporte: escalonamento para um atendente humano (porta
 * `app/skills/support.py`). Skill TERMINAL: tem `directResponse`, então ao ser
 * chamada o agente devolve a mensagem padrão e encerra o turno.
 */

import { z } from "zod";

import { trigger } from "../domain";
import { getLogger } from "../logging";
import { ATENDIMENTO_FINALIZADO, ESCALATION_SUPPORT } from "../messages";
import * as tickets from "../tickets";
import { CATEGORY_SUPPORT, registerLocal, SkillResult } from "./base";

const log = getLogger("blip-agent.skills.support");

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

// --- Abertura de chamados (tickets) ---------------------------------------- //

// Criticidade é DECIDIDA PELA IA. Enum fechado: o Zod rejeita qualquer outro valor
// e o modelo corrige na rodada seguinte de tool call.
const CRITICALITY = ["baixa", "normal", "alta"] as const;

const createTicketArgs = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe("Nome/assunto curto do chamado (ex.: 'Erro ao finalizar pedido')."),
  description: z
    .string()
    .min(1)
    .max(4000)
    .describe("Descrição detalhada do problema ou da solicitação do usuário."),
  user_name: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Nome do usuário que abriu o chamado. OBRIGATÓRIO — pergunte ao usuário se ainda não souber.",
    ),
  user_email: z
    .string()
    .email()
    .max(320)
    .describe(
      "E-mail do usuário que abriu o chamado. OBRIGATÓRIO — pergunte ao usuário se ainda não souber.",
    ),
  criticality: z
    .enum(CRITICALITY)
    .describe(
      "Criticidade que VOCÊ classifica pela gravidade: 'baixa' (dúvida simples, sem impacto), " +
        "'normal' (problema comum), 'alta' (bloqueio, urgência, risco financeiro ou muitos afetados).",
    ),
});

registerLocal(
  "create_ticket",
  "Abre e registra um chamado de suporte para acompanhamento posterior. Use quando o " +
    "usuário relata um problema ou faz uma solicitação que precisa de registro. Exige o " +
    "nome E o e-mail do usuário (peça-os antes se não os tiver); você define a criticidade " +
    "(baixa/normal/alta).",
  createTicketArgs,
  async (ctx, a) => {
    try {
      const ticket = await tickets.createTicket(ctx.agent, {
        title: a.title,
        description: a.description,
        userName: a.user_name,
        userEmail: a.user_email,
        criticality: a.criticality,
      });
      return new SkillResult({
        data: {
          created: true,
          ticket_id: ticket.id,
          criticality: ticket.criticality,
          created_at: ticket.createdAt,
          message: `Chamado #${ticket.id} registrado com criticidade ${ticket.criticality}.`,
        },
        // Evento acionável: o canal integrador pode notificar/roteirizar o chamado.
        triggers: [
          trigger("chamado_criado", `Chamado #${ticket.id} aberto.`, {
            ticket_id: ticket.id,
            title: ticket.title,
            criticality: ticket.criticality,
            user_name: ticket.userName,
            user_email: ticket.userEmail,
            created_at: ticket.createdAt,
          }),
        ],
      });
    } catch (e) {
      // Falha de banco NÃO derruba o turno em handoff: devolve erro como dado para
      // o modelo se desculpar e, se quiser, oferecer escalonamento.
      log.warn(`Falha ao abrir chamado (agent=${ctx.agent.id}): ${String(e)}`);
      return new SkillResult({
        data: { created: false, error: "Não foi possível registrar o chamado agora." },
      });
    }
  },
  CATEGORY_SUPPORT,
);

// --- Encerramento do atendimento ------------------------------------------- //

// Skill TERMINAL (tem directResponse): ao ser chamada, o agente devolve a
// despedida e encerra o turno. Diferente de escalate_to_human, NÃO faz handoff —
// o atendimento terminou resolvido, sem transferir para humano.
const finalizeArgs = z.object({
  reason: z
    .string()
    .default("")
    .describe("Motivo breve do encerramento (ex.: 'dúvida resolvida', 'cliente se despediu')."),
});

registerLocal(
  "finalizar_atendimento",
  "Encerra o atendimento quando a solicitação do cliente já foi resolvida e não há mais " +
    "nada a fazer (ex.: o cliente agradece, se despede ou confirma que está tudo certo). " +
    "Emite o evento de atendimento finalizado. NÃO use se o cliente ainda precisa de algo " +
    "ou se o caso exige um atendente humano (para isso use escalate_to_human).",
  finalizeArgs,
  (_ctx, args) =>
    new SkillResult({
      data: { finalized: true, reason: args.reason },
      directResponse: ATENDIMENTO_FINALIZADO,
      triggers: [trigger("atendimento_finalizado", args.reason || null)],
    }),
  CATEGORY_SUPPORT,
);
