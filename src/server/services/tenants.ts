/**
 * TenantService (porta `app/services/tenants.py`): ciclo de vida de tenants,
 * usuários e memberships. Criar um tenant cria também seu primeiro usuário OWNER.
 */

import { randomBytes } from "node:crypto";

import { DEFAULT_TENANT_ID } from "../config";
import type { Membership, MemberRole, Tenant, User } from "../domain";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getLogger } from "../logging";
import * as rag from "../rag";
import { AgentRepository } from "../repositories/agents";
import { MembershipRepository, TenantRepository, UserRepository } from "../repositories/tenants";
import { slugify } from "../textutil";

const log = getLogger("blip-agent.services.tenants");

function urlsafeToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
function newKey(prefix: string): string {
  return `blip-${prefix}-${urlsafeToken(24)}`;
}

export interface TenantCreateServiceData {
  id: string | null;
  name: string;
  ownerEmail: string;
  ownerName: string;
}

export interface MemberView {
  userId: string;
  role: string;
  email: string;
  name: string;
}

export interface MemberCreatedView {
  userId: string;
  email: string;
  role: string;
  apiKey: string;
}

export class TenantService {
  // Repositórios injetados por construtor (com default) — mesmo padrão de
  // AgentService/AnalyticsService: testável, sem estado global.
  constructor(
    private readonly tenants = new TenantRepository(),
    private readonly users = new UserRepository(),
    private readonly members = new MembershipRepository(),
    private readonly agents = new AgentRepository(),
  ) {}

  // --- tenants ------------------------------------------------------------- //
  list(): Promise<Tenant[]> {
    return this.tenants.list();
  }

  async get(tenantId: string): Promise<Tenant> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === null) throw new NotFoundError(`Tenant '${tenantId}' não encontrado.`);
    return tenant;
  }

  /** Cria o tenant + o primeiro usuário owner. Retorna { tenant, owner }. */
  async create(data: TenantCreateServiceData): Promise<{ tenant: Tenant; owner: User }> {
    const tenantId = slugify(data.id || data.name, "tenant");
    if (await this.tenants.exists(tenantId)) {
      throw new ConflictError(`Já existe um tenant com id '${tenantId}'.`);
    }
    await this.tenants.insert(tenantId, data.name, newKey("tenant"));
    const owner = await this.ensureUser(data.ownerEmail, data.ownerName);
    await this.members.upsert(tenantId, owner.id, "owner");
    log.info(`Tenant criado: ${tenantId} (owner=${owner.email})`);
    return { tenant: (await this.tenants.get(tenantId))!, owner };
  }

  /** Exclui o tenant. Agentes/produtos/memberships saem por cascade (FK); o RAG
   * de cada agente é removido explicitamente. */
  async delete(tenantId: string): Promise<{ deleted: string; deleted_chunks: number }> {
    if (!(await this.tenants.exists(tenantId))) {
      throw new NotFoundError(`Tenant '${tenantId}' não encontrado.`);
    }
    const tenantAgents = await this.agents.listForTenant(tenantId);
    let chunks = 0;
    for (const a of tenantAgents) chunks += await rag.deleteAgentData(a.id);
    await this.tenants.delete(tenantId);
    return { deleted: tenantId, deleted_chunks: chunks };
  }

  // --- membros ------------------------------------------------------------- //
  async listMembers(tenantId: string): Promise<MemberView[]> {
    const out: MemberView[] = [];
    for (const m of await this.members.listForTenant(tenantId)) {
      const user = await this.users.get(m.userId);
      out.push({ userId: m.userId, role: m.role, email: user?.email ?? "", name: user?.name ?? "" });
    }
    return out;
  }

  async addMember(tenantId: string, email: string, role: MemberRole, name = ""): Promise<MemberCreatedView> {
    if (role !== "owner" && role !== "member") {
      throw new ValidationError("Papel inválido (use 'owner' ou 'member').");
    }
    const user = await this.ensureUser(email, name);
    await this.members.upsert(tenantId, user.id, role);
    log.info(`Membership ${email} -> ${tenantId} (${role})`);
    return { userId: user.id, email: user.email, role, apiKey: user.apiKey };
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    const membership = await this.members.get(tenantId, userId);
    if (membership === null) throw new NotFoundError("Membership não encontrada.");
    if (membership.role === "owner" && (await this.members.countOwners(tenantId)) <= 1) {
      throw new ValidationError("Não é possível remover o último owner do tenant.");
    }
    await this.members.delete(tenantId, userId);
  }

  membershipOf(tenantId: string, userId: string): Promise<Membership | null> {
    return this.members.get(tenantId, userId);
  }

  // --- bootstrap ----------------------------------------------------------- //
  /** Garante o tenant `default` (idempotente). Loga a api_key uma vez. */
  async ensureDefaultTenant(): Promise<Tenant> {
    const existing = await this.tenants.get(DEFAULT_TENANT_ID);
    if (existing) return existing;
    const apiKey = newKey("tenant");
    await this.tenants.insert(DEFAULT_TENANT_ID, "Default", apiKey);
    log.warn(`Tenant '${DEFAULT_TENANT_ID}' criado. api_key=${apiKey} (guarde — usada para chat/consumo).`);
    return (await this.tenants.get(DEFAULT_TENANT_ID))!;
  }

  // --- internos ------------------------------------------------------------ //
  private async ensureUser(email: string, name: string): Promise<User> {
    const existing = await this.users.getByEmail(email);
    if (existing) return existing;
    const userId = `usr-${urlsafeToken(8)}`;
    await this.users.insert(userId, email, name, newKey("user"));
    return (await this.users.get(userId))!;
  }
}
