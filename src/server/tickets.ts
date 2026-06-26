/**
 * Chamados de suporte: a função pública que a skill `create_ticket` chama (mesmo
 * papel que `catalog.ts` tem para o catálogo). Faz a escrita via repositório e
 * devolve dado JSON-ready para o LLM confirmar ao usuário.
 *
 * Privacidade: o log NÃO inclui nome/e-mail do usuário (PII) — só o id do chamado,
 * o agente e a criticidade.
 */

import type { AgentConfig, TicketCreateInput, TicketRow } from "./domain";
import { getLogger } from "./logging";
import { TicketRepository } from "./repositories/tickets";

const log = getLogger("blip-agent.tickets");

const repo = new TicketRepository();

export async function createTicket(agent: AgentConfig, data: TicketCreateInput): Promise<TicketRow> {
  const ticket = await repo.create(agent.id, data);
  log.info(`Chamado #${ticket.id} aberto (agent=${agent.id}) criticidade=${ticket.criticality}`);
  return ticket;
}
