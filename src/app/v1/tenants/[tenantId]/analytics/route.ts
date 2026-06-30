import { requireMember } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { dashboardPublic } from "@/server/http/serialize";
import { getAnalyticsService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId}/analytics?days=30&agent=<slug> (member) — dashboard
// do time de dados: % de transbordo, sucesso sem transbordo, tokens, intents,
// skills, série por dia e logs recentes. `agent` (slug) filtra um agente; sem ele,
// agrega o tenant inteiro (com quebra por agente).
export const GET = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireMember(req, tenantId);
  const url = new URL(req.url);
  const daysRaw = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  const dashboard = await getAnalyticsService().dashboard(tenantId, {
    days: Number.isNaN(daysRaw) ? 30 : daysRaw,
    agentSlug: url.searchParams.get("agent"),
  });
  return json(dashboardPublic(dashboard));
});
