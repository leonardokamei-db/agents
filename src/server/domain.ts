/**
 * Tipos de domínio compartilhados (porta `app/domain.py`).
 *
 * Convenção: internamente usamos camelCase (idiomático em TS). O contrato HTTP é
 * snake_case e a conversão acontece SÓ na fronteira (schemas Zod na entrada,
 * serializadores em `http/serialize.ts` na saída) — preservando a API atual.
 *
 * AgentResult (saída do AGENTE) ≠ ChatResponse (contrato da API): intent/
 * agentUsed/confidence são injetados pelo Orchestrator, não pelo agente.
 */

export type Role = "system" | "user" | "assistant" | "tool";
export type ProductMode = "none" | "internal" | "external";
export type MemberRole = "owner" | "member";
export type PrincipalRole = "admin" | "owner" | "member";

/** Mensagem no formato de histórico (role user/assistant/system + texto). */
export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  apiKey: string;
  createdAt: string;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: MemberRole;
}

/** Quem faz a requisição, já resolvido (RBAC). */
export interface Principal {
  role: PrincipalRole;
  tenantId?: string;
  userId?: string;
}

/** owner/admin gerenciam agentes e membros; member tem leitura+chat+conteúdo. */
export function canManage(p: Principal): boolean {
  return p.role === "admin" || p.role === "owner";
}

/** Configuração de um agente, tipada. Espelha a tabela `agents`. */
export interface AgentConfig {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  systemPrompt: string;
  businessRules: string;
  maxTurns: number;
  productMode: ProductMode;
  productApiUrl: string;
  productApiKey: string;
  ragEnabled: boolean;
  externalProducts: boolean;
  skills: string[];
  createdAt: string;
}

/** Produto normalizado — mesmo shape para catálogo interno e API externa. */
export interface ProductRow {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  unit: string;
}

/** Item da API externa do cliente (campos podem faltar — usa defaults). */
export function productRowFromExternal(
  p: Record<string, unknown>,
  fallbackId = 0,
): ProductRow {
  return {
    id: Math.trunc(Number(p.id ?? fallbackId)) || fallbackId,
    name: String(p.name ?? ""),
    description: String(p.description ?? ""),
    price: Number(p.price ?? 0) || 0,
    stock: Math.trunc(Number(p.stock ?? 0)) || 0,
    unit: String(p.unit ?? "unidade") || "unidade",
  };
}

/** Criticidade de um chamado — classificada pela IA na skill `create_ticket`. */
export type TicketCriticality = "baixa" | "normal" | "alta";

/** Chamado de suporte registrado — espelha a tabela `tickets`. */
export interface TicketRow {
  id: number;
  title: string;
  description: string;
  userName: string;
  userEmail: string;
  criticality: TicketCriticality;
  createdAt: string;
}

/** Dados para abrir um chamado (DTO camelCase consumido pelo repositório). */
export interface TicketCreateInput {
  title: string;
  description: string;
  userName: string;
  userEmail: string;
  criticality: TicketCriticality;
}

/** Saída padronizada de qualquer agente. */
export interface AgentResult {
  response: string;
  shouldHandoff: boolean;
  handoffReason: string | null;
  source: string;
  tokensUsed: number;
  toolsCalled: string[];
  ragChunksUsed: number;
  ragSources: string[];
}

/** Constrói um AgentResult preenchendo os defaults. */
export function agentResult(partial: Partial<AgentResult> & { response: string }): AgentResult {
  return {
    response: partial.response,
    shouldHandoff: partial.shouldHandoff ?? false,
    handoffReason: partial.handoffReason ?? null,
    source: partial.source ?? "llm",
    tokensUsed: partial.tokensUsed ?? 0,
    toolsCalled: partial.toolsCalled ?? [],
    ragChunksUsed: partial.ragChunksUsed ?? 0,
    ragSources: partial.ragSources ?? [],
  };
}
