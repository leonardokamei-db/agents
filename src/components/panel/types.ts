/**
 * Tipos wire (snake_case, como a API devolve) e aliases compartilhados pelos
 * componentes do painel admin. A conversão camelCase↔snake_case do backend fica
 * na fronteira do servidor; o front consome o formato do fio direto.
 */

export interface TenantPublic {
  id: string;
  name: string;
  created_at: string;
}
export interface TenantCreated extends TenantPublic {
  api_key: string;
  owner_email: string;
  owner_api_key: string;
}
export interface AgentPublic {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  system_prompt: string;
  business_rules: string;
  max_turns: number;
  product_mode: "none" | "internal" | "external";
  product_api_url: string;
  rag_enabled: boolean;
  external_products: boolean;
  skills: string[];
  endpoint: string;
  created_at: string;
}
export interface ChatMeta {
  agent_used: string;
  intent: string;
  confidence: number;
  source: string;
  tokens_used: number;
  rag_chunks_used: number;
  tools_called: string[];
  should_handoff: boolean;
  response: string;
}
export interface ChatMsg {
  role: "user" | "bot";
  text: string;
  meta?: ChatMeta;
}
export interface SourceInfo {
  source_name: string;
  chunk_count: number;
  last_updated: string;
}
export interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  unit: string;
}
export interface Member {
  user_id: string;
  email: string;
  name: string;
  role: string;
}
export interface SkillCatalogItem {
  name: string;
  description: string;
  category: string;
  always_on: boolean;
  requires: "rag" | "catalog" | null;
}

/** Abas/telas do painel. */
export type View =
  | "chat"
  | "config"
  | "knowledge"
  | "products"
  | "members"
  | "createTenant"
  | "createAgent";

/** Assinatura do helper de API do painel (X-Admin-Key + X-API-Key opcional). */
export type ApiFn = (path: string, opts?: RequestInit, apiKey?: string | null) => Promise<any>;

/** Exibe um toast (erro = vermelho). */
export type ToastFn = (msg: string, error?: boolean) => void;
