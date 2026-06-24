import { requireOwner } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { memberCreated, memberInfo } from "@/server/http/serialize";
import { memberCreateSchema } from "@/server/schemas";
import { getTenantService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId}/members (owner) — lista membros.
export const GET = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireOwner(req, tenantId);
  const members = await getTenantService().listMembers(tenantId);
  return json(members.map(memberInfo));
});

// POST /v1/tenants/{tenantId}/members (owner) — convida usuário -> gera api_key.
export const POST = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireOwner(req, tenantId);
  const input = await parseBody(req, memberCreateSchema);
  const created = await getTenantService().addMember(tenantId, input.email, input.role, input.name);
  return json(memberCreated(created, input.name), 201);
});
