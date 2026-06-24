import { requireMember } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { getAgentService, getKnowledgeService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE .../knowledge/sources/{name} (member) — remove uma fonte e seus chunks.
export const DELETE = route<{ tenantId: string; slug: string; name: string }>(async (req, { tenantId, slug, name }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  return json(await getKnowledgeService().deleteSource(agent, decodeURIComponent(name)));
});
