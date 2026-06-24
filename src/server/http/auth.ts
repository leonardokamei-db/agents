/**
 * Autenticação + RBAC (porta `app/routers/deps.py`).
 *
 * Hierarquia de credenciais:
 *   - X-Admin-Key == ADMIN_API_KEY  -> admin de plataforma (cria/exclui tenants).
 *   - X-API-Key == api_key do tenant -> owner do próprio tenant.
 *   - X-API-Key == api_key de usuário -> papel da membership (owner | member).
 */

import type { NextRequest } from "next/server";

import { ADMIN_API_KEY } from "../config";
import { canManage, type Principal } from "../domain";
import { ForbiddenError, UnauthorizedError } from "../errors";
import { MembershipRepository, TenantRepository, UserRepository } from "../repositories/tenants";

const tenants = new TenantRepository();
const users = new UserRepository();
const members = new MembershipRepository();

export function apiKeyOf(req: NextRequest): string | null {
  return req.headers.get("x-api-key");
}
export function adminKeyOf(req: NextRequest): string | null {
  return req.headers.get("x-admin-key");
}

export async function resolvePrincipal(tenantId: string, apiKey: string | null): Promise<Principal> {
  if (!apiKey) throw new UnauthorizedError("Informe a X-API-Key.");
  if (apiKey === ADMIN_API_KEY) return { role: "admin", tenantId };

  const tenant = await tenants.getByApiKey(apiKey);
  if (tenant !== null) {
    if (tenant.id !== tenantId) throw new ForbiddenError("Chave de tenant não corresponde a este tenant.");
    return { role: "owner", tenantId };
  }

  const user = await users.getByApiKey(apiKey);
  if (user !== null) {
    const membership = await members.get(tenantId, user.id);
    if (membership === null) throw new ForbiddenError("Usuário não é membro deste tenant.");
    return { role: membership.role, tenantId, userId: user.id };
  }

  throw new UnauthorizedError("API key inválida.");
}

/** Qualquer papel válido no tenant (leitura/chat/conteúdo). */
export function requireMember(req: NextRequest, tenantId: string): Promise<Principal> {
  return resolvePrincipal(tenantId, apiKeyOf(req));
}

/** Restringe a owners do tenant (e admin de plataforma). */
export async function requireOwner(req: NextRequest, tenantId: string): Promise<Principal> {
  const principal = await requireMember(req, tenantId);
  if (!canManage(principal)) throw new ForbiddenError("Ação restrita a owners do tenant.");
  return principal;
}

/** Operações de plataforma (criar/excluir tenants). */
export function requirePlatformAdmin(req: NextRequest): void {
  if (adminKeyOf(req) !== ADMIN_API_KEY) throw new UnauthorizedError("Chave de administração inválida.");
}
