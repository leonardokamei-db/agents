/**
 * Schema Drizzle — fonte única para as queries tipadas (repositories).
 *
 * Porta o modelo de `app/db.py` + `app/rag.py`(DDL) para Postgres + pgvector,
 * num ÚNICO banco (antes eram core.db relacional e rag.db vetorial).
 *
 * IMPORTANTE: o DDL efetivo de criação das tabelas (idempotente, com a extensão
 * pgvector) vive em `src/server/db/ddl.ts` e é aplicado por `scripts/setup-db.ts`.
 * Mantê-los em sincronia é invariante — ver o comentário em ddl.ts.
 *
 * Modelo: um TENANT é dono de N AGENTES; USERS se vinculam a tenants via
 * MEMBERSHIPS com papel (owner/member). A credencial de consumo vive no tenant
 * (não há api_key por agente).
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | member
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(), // PK opaca: {tenant}__{slug}
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(), // único dentro do tenant
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    businessRules: text("business_rules").notNull().default(""),
    maxTurns: integer("max_turns").notNull().default(15),
    productMode: text("product_mode").notNull().default("none"), // none | internal | external
    productApiUrl: text("product_api_url").notNull().default(""),
    productApiKey: text("product_api_key").notNull().default(""),
    ragEnabled: boolean("rag_enabled").notNull().default(true),
    externalProducts: boolean("external_products").notNull().default(true),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("agents_tenant_slug_uq").on(t.tenantId, t.slug)],
);

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: real("price").notNull(),
  stock: integer("stock").notNull().default(0),
  unit: text("unit").notNull().default("unidade"),
});

// Chamados (tickets) de suporte abertos pelo agente via a skill `create_ticket`.
// Escopados por agente (agent_id) — mesma invariante de isolamento dos produtos.
// `created_at` (a "data" do chamado) é definido pelo banco, nunca pelo LLM; a
// `criticality` é classificada pela IA (baixa | normal | alta — texto livre no
// banco, validado por Zod na fronteira da skill). Índice criado no ddl.ts.
export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  userName: text("user_name").notNull(),
  userEmail: text("user_email").notNull(),
  criticality: text("criticality").notNull().default("normal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Telemetria de interações: UMA linha por mensagem processada no chat. Alimenta o
// dashboard do time de dados (% de transbordo, sucesso sem transbordo, tokens...).
// Escopada por agente (agent_id) E por tenant (tenant_id, desnormalizado para
// agregações por tenant sem join) — mesma invariante de isolamento dos produtos.
// PRIVACIDADE: NÃO guarda o texto da mensagem nem da resposta (sem PII) — só os
// metadados telemétricos que o Orchestrator já produz. Índices criados no ddl.ts.
export const interactions = pgTable("interactions", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  intent: text("intent").notNull().default(""),
  source: text("source").notNull().default(""),
  agentUsed: text("agent_used").notNull().default(""),
  tokensUsed: integer("tokens_used").notNull().default(0),
  shouldHandoff: boolean("should_handoff").notNull().default(false),
  handoffReason: text("handoff_reason").notNull().default(""),
  toolsCalled: jsonb("tools_called").$type<string[]>().notNull().default([]),
  ragChunksUsed: integer("rag_chunks_used").notNull().default(0),
  confidence: real("confidence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Vector store RAG (antes rag.db/sqlite-vec). Uma só tabela com a coluna
// `embedding vector(384)`; a busca KNN filtra por agent_id no WHERE (pgvector),
// eliminando o over-fetch x3 que o sqlite-vec exigia. Sem FK de propósito: a
// limpeza do RAG é explícita ao excluir agente/tenant (espelha o store separado).
export const chunks = pgTable("chunks", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  sourceName: text("source_name").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 384 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
