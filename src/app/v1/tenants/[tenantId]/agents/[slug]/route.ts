import { requireMember, requireOwner } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { agentPublic } from "@/server/http/serialize";
import { getAgentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId}/agents/{slug} (member) — config pública do agente.
export const GET = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  return json(agentPublic(await getAgentService().get(tenantId, slug)));
});

// DELETE /v1/tenants/{tenantId}/agents/{slug} (owner) — exclui agente (cascade + RAG).
export const DELETE = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireOwner(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const deletedChunks = await getAgentService().delete(agent);
  return json({ deleted: agent.slug, deleted_chunks: deletedChunks });
});
