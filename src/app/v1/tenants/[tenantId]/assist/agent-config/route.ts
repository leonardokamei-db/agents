import { requireOwner } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { assistConfig } from "@/server/http/serialize";
import { assistConfigSchema, toAssistConfig } from "@/server/schemas";
import { getAssistService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /v1/tenants/{tenantId}/assist/agent-config (owner) — usa a IA para rascunhar
// system_prompt + business_rules a partir de um briefing do time de UX. Devolve uma
// SUGESTÃO; o time revisa e salva pelo PUT .../config (que sanitiza ao persistir).
export const POST = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireOwner(req, tenantId);
  const input = await parseBody(req, assistConfigSchema);
  const result = await getAssistService().draftAgentConfig(toAssistConfig(input));
  return json(assistConfig(result));
});
