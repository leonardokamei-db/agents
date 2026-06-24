import { requireOwner } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { agentPublic } from "@/server/http/serialize";
import { agentUpdateSchema, toAgentUpdate } from "@/server/schemas";
import { getAgentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /v1/tenants/{tenantId}/agents/{slug}/config (owner) — edita prompt/regras/flags.
export const PUT = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireOwner(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const input = await parseBody(req, agentUpdateSchema);
  const updated = await getAgentService().update(agent, toAgentUpdate(input));
  return json(agentPublic(updated));
});
