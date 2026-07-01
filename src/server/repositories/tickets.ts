/**
 * Repositório de chamados (tickets) de suporte (segue o padrão de `products.ts`).
 *
 * INVARIANTE DE TENANCY: `create` recebe `agentId` e SEMPRE grava `agent_id` na
 * linha — o chamado nasce escopado ao agente/tenant. Esse `agentId` vem de
 * `ctx.agent.id` (a configuração do agente), nunca dos argumentos do LLM, então o
 * cliente não tem como abrir um chamado em nome de outro agente.
 */

import { db } from "../db/client";
import { tickets } from "../db/schema";
import type { TicketCreateInput, TicketCriticality, TicketRow } from "../domain";
import { toIso } from "./util";

type TicketDbRow = typeof tickets.$inferSelect;

function toTicketRow(r: TicketDbRow): TicketRow {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    userName: r.userName,
    userEmail: r.userEmail,
    criticality: (r.criticality ?? "normal") as TicketCriticality,
    createdAt: toIso(r.createdAt),
  };
}

export class TicketRepository {
  /** Insere um chamado escopado ao agente e devolve a linha criada (com id/data). */
  async create(agentId: string, data: TicketCreateInput): Promise<TicketRow> {
    const inserted = await db
      .insert(tickets)
      .values({
        agentId,
        title: data.title,
        description: data.description ?? "",
        userName: data.userName,
        userEmail: data.userEmail,
        criticality: data.criticality,
      })
      .returning();
    return toTicketRow(inserted[0]);
  }
}
