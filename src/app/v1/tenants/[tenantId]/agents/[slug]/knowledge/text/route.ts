import { requireMember } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { textIngestSchema } from "@/server/schemas";
import { getAgentService, getKnowledgeService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST .../knowledge/text (member) — ingere texto puro (síncrono).
export const POST = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const input = await parseBody(req, textIngestSchema);
  const result = await getKnowledgeService().ingestText(agent, input.text, input.source_name);
  return json(result);
});
