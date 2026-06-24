import { requireMember } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { chatResponse } from "@/server/http/serialize";
import { getLlm } from "@/server/llm";
import { Orchestrator } from "@/server/orchestrator";
import { chatRequestSchema } from "@/server/schemas";
import { getAgentService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /v1/tenants/{tenantId}/agents/{slug}/chat (member) — a "porta" do agente.
export const POST = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const input = await parseBody(req, chatRequestSchema);
  const orchestrator = new Orchestrator(agent, getLlm());
  const result = await orchestrator.process(input.message, input.history);
  return json(chatResponse(result));
});
