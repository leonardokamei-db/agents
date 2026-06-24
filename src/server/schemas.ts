/**
 * Schemas Zod (porta `app/schemas/*`, Pydantic).
 *
 * Validam o corpo das requisições no formato de fio (snake_case, contrato atual)
 * e os mapeadores `to*` convertem para os DTOs camelCase consumidos pelos services.
 * Segredos (product_api_key) nunca entram numa resposta — ver `http/serialize.ts`.
 */

import { z } from "zod";

const productMode = z.enum(["none", "internal", "external"]);

// --- Chat ------------------------------------------------------------------- //
export const chatRequestSchema = z.object({
  message: z.string(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  conversation_id: z.string().nullish(),
});
export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

// --- Tenants / membros ------------------------------------------------------ //
export const tenantCreateSchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  owner_email: z.string(),
  owner_name: z.string().default(""),
});
export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;
export function toTenantCreate(i: TenantCreateInput) {
  return { id: i.id ?? null, name: i.name, ownerEmail: i.owner_email, ownerName: i.owner_name };
}

export const memberCreateSchema = z.object({
  email: z.string(),
  role: z.enum(["owner", "member"]).default("member"),
  name: z.string().default(""),
});
export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

// --- Agentes ---------------------------------------------------------------- //
export const agentCreateSchema = z.object({
  slug: z.string().nullish(),
  name: z.string(),
  system_prompt: z.string().default(""),
  business_rules: z.string().default(""),
  max_turns: z.number().int().default(15),
  product_mode: productMode.default("none"),
  product_api_url: z.string().default(""),
  product_api_key: z.string().default(""),
  rag_enabled: z.boolean().default(true),
  external_products: z.boolean().default(true),
  skills: z.array(z.string()).default([]),
});
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

export interface AgentCreateData {
  slug: string | null;
  name: string;
  systemPrompt: string;
  businessRules: string;
  maxTurns: number;
  productMode: "none" | "internal" | "external";
  productApiUrl: string;
  productApiKey: string;
  ragEnabled: boolean;
  externalProducts: boolean;
  skills: string[];
}

export function toAgentCreate(i: AgentCreateInput): AgentCreateData {
  return {
    slug: i.slug ?? null,
    name: i.name,
    systemPrompt: i.system_prompt,
    businessRules: i.business_rules,
    maxTurns: i.max_turns,
    productMode: i.product_mode,
    productApiUrl: i.product_api_url,
    productApiKey: i.product_api_key,
    ragEnabled: i.rag_enabled,
    externalProducts: i.external_products,
    skills: i.skills,
  };
}

export const agentUpdateSchema = z.object({
  name: z.string().optional(),
  system_prompt: z.string().optional(),
  business_rules: z.string().optional(),
  max_turns: z.number().int().optional(),
  product_mode: productMode.optional(),
  product_api_url: z.string().optional(),
  product_api_key: z.string().optional(),
  rag_enabled: z.boolean().optional(),
  external_products: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
});
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;

export type AgentUpdateData = Partial<Omit<AgentCreateData, "slug">>;

/** Mapeia só os campos presentes (espelha model_dump(exclude_unset=True)). */
export function toAgentUpdate(i: AgentUpdateInput): AgentUpdateData {
  const out: AgentUpdateData = {};
  if (i.name !== undefined) out.name = i.name;
  if (i.system_prompt !== undefined) out.systemPrompt = i.system_prompt;
  if (i.business_rules !== undefined) out.businessRules = i.business_rules;
  if (i.max_turns !== undefined) out.maxTurns = i.max_turns;
  if (i.product_mode !== undefined) out.productMode = i.product_mode;
  if (i.product_api_url !== undefined) out.productApiUrl = i.product_api_url;
  if (i.product_api_key !== undefined) out.productApiKey = i.product_api_key;
  if (i.rag_enabled !== undefined) out.ragEnabled = i.rag_enabled;
  if (i.external_products !== undefined) out.externalProducts = i.external_products;
  if (i.skills !== undefined) out.skills = i.skills;
  return out;
}

// --- Produtos --------------------------------------------------------------- //
export const productCreateSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  price: z.number(),
  stock: z.number().int().default(0),
  unit: z.string().default("unidade"),
});
export type ProductCreateInput = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.number().optional(),
  stock: z.number().int().optional(),
  unit: z.string().optional(),
});
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export function toProductUpdate(i: ProductUpdateInput): Partial<ProductCreateInput> {
  const out: Partial<ProductCreateInput> = {};
  if (i.name !== undefined) out.name = i.name;
  if (i.description !== undefined) out.description = i.description;
  if (i.price !== undefined) out.price = i.price;
  if (i.stock !== undefined) out.stock = i.stock;
  if (i.unit !== undefined) out.unit = i.unit;
  return out;
}

// --- Conhecimento ----------------------------------------------------------- //
export const textIngestSchema = z.object({
  source_name: z.string(),
  text: z.string(),
});
export type TextIngestInput = z.infer<typeof textIngestSchema>;
