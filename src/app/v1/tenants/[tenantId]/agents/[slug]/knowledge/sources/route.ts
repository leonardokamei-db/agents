import { requireMember } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { getAgentService, getKnowledgeService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET .../knowledge/sources (member) — fontes ingeridas, com contagem de chunks.
export const GET = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  return json(await getKnowledgeService().listSources(agent));
});
