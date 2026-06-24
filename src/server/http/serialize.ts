/**
 * Serializadores para o formato de fio (snake_case) — fronteira camelCase->wire.
 * Mantém o contrato HTTP atual. Segredos (product_api_key) NUNCA são incluídos.
 */

import type { AgentConfig, ProductRow, Tenant, User } from "../domain";
import type { ProcessResult } from "../orchestrator";
import type { MemberCreatedView, MemberView } from "../services/tenants";

export function agentPublic(a: AgentConfig) {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    slug: a.slug,
    name: a.name,
    system_prompt: a.systemPrompt,
    business_rules: a.businessRules,
    max_turns: a.maxTurns,
    product_mode: a.productMode,
    product_api_url: a.productApiUrl, // product_api_key omitido de propósito (segredo)
    rag_enabled: a.ragEnabled,
    external_products: a.externalProducts,
    skills: a.skills,
    endpoint: `/v1/tenants/${a.tenantId}/agents/${a.slug}/chat`,
    created_at: a.createdAt,
  };
}

export function tenantPublic(t: Tenant) {
  return { id: t.id, name: t.name, created_at: t.createdAt };
}

export function tenantCreated(t: Tenant, owner: User) {
  return {
    id: t.id,
    name: t.name,
    created_at: t.createdAt,
    api_key: t.apiKey,
    owner_email: owner.email,
    owner_api_key: owner.apiKey,
  };
}

export function memberInfo(m: MemberView) {
  return { user_id: m.userId, email: m.email, name: m.name, role: m.role };
}

export function memberCreated(m: MemberCreatedView, name: string) {
  return { user_id: m.userId, email: m.email, name, role: m.role, api_key: m.apiKey };
}

export function productInfo(p: ProductRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    stock: p.stock,
    unit: p.unit,
  };
}

export function chatResponse(r: ProcessResult) {
  return {
    response: r.response,
    should_handoff: r.shouldHandoff,
    handoff_reason: r.handoffReason,
    intent: r.intent,
    agent_used: r.agentUsed,
    source: r.source,
    confidence: r.confidence,
    tokens_used: r.tokensUsed,
    tools_called: r.toolsCalled,
    rag_chunks_used: r.ragChunksUsed,
    rag_sources: r.ragSources,
  };
}
