/**
 * Camada de services (porta `app/services/__init__.py`): regra de negócio entre
 * as rotas e os repositórios/domínio. Stateless — singletons + getters.
 */

import { getLlm } from "../llm";
import { AgentService } from "./agents";
import { AnalyticsService } from "./analytics";
import { AssistService } from "./assist";
import { KnowledgeService } from "./knowledge";
import { ProductService } from "./products";
import { TenantService } from "./tenants";

const agentService = new AgentService();
const tenantService = new TenantService();
const productService = new ProductService();
const knowledgeService = new KnowledgeService();
const analyticsService = new AnalyticsService();
// O assistente depende do LLMClient (singleton de getLlm), criado no 1º uso (lazy).
let assistService: AssistService | null = null;

export function getAgentService(): AgentService {
  return agentService;
}
export function getTenantService(): TenantService {
  return tenantService;
}
export function getProductService(): ProductService {
  return productService;
}
export function getKnowledgeService(): KnowledgeService {
  return knowledgeService;
}
export function getAnalyticsService(): AnalyticsService {
  return analyticsService;
}
export function getAssistService(): AssistService {
  if (assistService === null) assistService = new AssistService(getLlm());
  return assistService;
}

export { AgentService, TenantService, ProductService, KnowledgeService, AnalyticsService, AssistService };
