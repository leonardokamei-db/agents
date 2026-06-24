/**
 * Camada de services (porta `app/services/__init__.py`): regra de negócio entre
 * as rotas e os repositórios/domínio. Stateless — singletons + getters.
 */

import { AgentService } from "./agents";
import { KnowledgeService } from "./knowledge";
import { ProductService } from "./products";
import { TenantService } from "./tenants";

const agentService = new AgentService();
const tenantService = new TenantService();
const productService = new ProductService();
const knowledgeService = new KnowledgeService();

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

export { AgentService, TenantService, ProductService, KnowledgeService };
