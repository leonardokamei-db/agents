/**
 * Serializadores para o formato de fio (snake_case) — fronteira camelCase->wire.
 * Mantém o contrato HTTP atual. Segredos (product_api_key) NUNCA são incluídos.
 */

import type { AgentConfig, ProductRow, Tenant, User } from "../domain";
import type { ProcessResult } from "../orchestrator";
import type { Dashboard } from "../services/analytics";
import type { AssistConfigResult } from "../services/assist";
import type { MemberCreatedView, MemberView } from "../services/tenants";
import type { SkillInfo } from "../skills";

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

/** Catálogo de skills (descrições) — para o time de UX montar a config. */
export function skillInfo(s: SkillInfo) {
  return {
    name: s.name,
    description: s.description,
    category: s.category,
    always_on: s.alwaysOn,
    requires: s.requires,
  };
}

/** Rascunho de configuração gerado pela IA (assistente do time de UX). */
export function assistConfig(r: AssistConfigResult) {
  return {
    system_prompt: r.systemPrompt,
    business_rules: r.businessRules,
    notes: r.notes,
    tokens_used: r.tokensUsed,
  };
}

/** Dashboard do time de dados (métricas de transbordo, tokens, intents, logs). */
export function dashboardPublic(d: Dashboard) {
  return {
    range: { days: d.range.days, since: d.range.since, agent_slug: d.range.agentSlug },
    summary: {
      total: d.summary.total,
      handoff_count: d.summary.handoffCount,
      success_no_handoff: d.summary.successNoHandoff,
      handoff_rate: d.summary.handoffRate,
      success_rate: d.summary.successRate,
      tokens_total: d.summary.tokensTotal,
      tokens_avg: d.summary.tokensAvg,
    },
    by_day: d.byDay.map((p) => ({ day: p.day, count: p.count, handoffs: p.handoffs, tokens: p.tokens })),
    by_intent: d.byIntent.map((p) => ({ label: p.label, count: p.count })),
    by_source: d.bySource.map((p) => ({ label: p.label, count: p.count })),
    by_agent: d.byAgent.map((a) => ({
      slug: a.slug,
      agent_id: a.agentId,
      count: a.count,
      handoffs: a.handoffs,
      tokens: a.tokens,
    })),
    top_tools: d.topTools.map((p) => ({ label: p.label, count: p.count })),
    recent: d.recent.map((r) => ({
      id: r.id,
      slug: r.slug,
      agent_id: r.agentId,
      intent: r.intent,
      source: r.source,
      agent_used: r.agentUsed,
      tokens_used: r.tokensUsed,
      should_handoff: r.shouldHandoff,
      handoff_reason: r.handoffReason,
      tools_called: r.toolsCalled,
      rag_chunks_used: r.ragChunksUsed,
      confidence: r.confidence,
      created_at: r.createdAt,
    })),
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
