import { requireMember, requireOwner } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { agentPublic } from "@/server/http/serialize";
import { agentCreateSchema, toAgentCreate } from "@/server/schemas";
import { getAgentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId}/agents (member) — lista agentes do tenant.
export const GET = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireMember(req, tenantId);
  const agents = await getAgentService().listForTenant(tenantId);
  return json(agents.map(agentPublic));
});

// POST /v1/tenants/{tenantId}/agents (owner) — cria agente -> abre o endpoint.
export const POST = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireOwner(req, tenantId);
  const input = await parseBody(req, agentCreateSchema);
  const agent = await getAgentService().create(tenantId, toAgentCreate(input));
  return json(agentPublic(agent), 201);
});
