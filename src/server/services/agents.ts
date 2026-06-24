/**
 * AgentService (porta `app/services/agents.py`): regra de negócio de agentes.
 * Criar um agente "abre" o endpoint dele (resolução por (tenant, slug) a cada
 * requisição). A PK é prefixada por tenant ({tenant}__{slug}).
 */

import type { AgentConfig, ProductMode } from "../domain";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getLogger } from "../logging";
import * as rag from "../rag";
import { AgentRepository } from "../repositories/agents";
import type { AgentCreateData, AgentUpdateData } from "../schemas";
import { allSkillNames } from "../skills";
import { slugify } from "../textutil";

const log = getLogger("blip-agent.services.agents");

export class AgentService {
  constructor(private readonly repo: AgentRepository = new AgentRepository()) {}

  // --- leitura ------------------------------------------------------------- //
  listForTenant(tenantId: string): Promise<AgentConfig[]> {
    return this.repo.listForTenant(tenantId);
  }

  listAll(): Promise<AgentConfig[]> {
    return this.repo.listAll();
  }

  async get(tenantId: string, slug: string): Promise<AgentConfig> {
    const agent = await this.repo.get(tenantId, slug);
    if (agent === null) throw new NotFoundError(`Agente '${slug}' não encontrado neste tenant.`);
    return agent;
  }

  // --- escrita ------------------------------------------------------------- //
  async create(tenantId: string, data: AgentCreateData): Promise<AgentConfig> {
    const slug = slugify(data.slug || data.name, "agente");
    if (await this.repo.exists(tenantId, slug)) {
      throw new ConflictError(`Já existe um agente '${slug}' neste tenant.`);
    }
    AgentService.checkExternal(data.productMode, data.externalProducts);
    AgentService.checkSkills(data.skills);
    const agentId = `${tenantId}__${slug}`;
    await this.repo.insert(agentId, tenantId, slug, data);
    log.info(`Agente criado: ${agentId} (tenant=${tenantId})`);
    return (await this.repo.getById(agentId))!;
  }

  async update(agent: AgentConfig, changes: AgentUpdateData): Promise<AgentConfig> {
    const mode: ProductMode = changes.productMode ?? agent.productMode;
    const ext = changes.externalProducts ?? agent.externalProducts;
    AgentService.checkExternal(mode, ext);
    if (changes.skills !== undefined) AgentService.checkSkills(changes.skills);
    await this.repo.update(agent.id, changes);
    return (await this.repo.getById(agent.id))!;
  }

  /** Exclui o agente e a base de conhecimento dele (produtos saem por cascade). */
  async delete(agent: AgentConfig): Promise<number> {
    await this.repo.delete(agent.id);
    return rag.deleteAgentData(agent.id);
  }

  // --- validação ----------------------------------------------------------- //
  private static checkExternal(productMode: ProductMode, externalEnabled: boolean): void {
    if (productMode === "external" && !externalEnabled) {
      throw new ValidationError(
        "Catálogo externo desabilitado para este agente (feature flag external_products=false).",
      );
    }
  }

  private static checkSkills(skills: string[] | undefined): void {
    if (!skills || skills.length === 0) return;
    const valid = new Set(allSkillNames());
    const unknown = skills.filter((s) => !valid.has(s)).sort();
    if (unknown.length > 0) {
      throw new ValidationError(
        `Skills desconhecidas: ${JSON.stringify(unknown)}. Disponíveis: ${JSON.stringify([...valid].sort())}.`,
      );
    }
  }
}
