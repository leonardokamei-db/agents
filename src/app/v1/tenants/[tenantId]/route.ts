import { requireMember, requirePlatformAdmin } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { tenantPublic } from "@/server/http/serialize";
import { getTenantService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId} (member) — dados do tenant.
export const GET = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireMember(req, tenantId);
  return json(tenantPublic(await getTenantService().get(tenantId)));
});

// DELETE /v1/tenants/{tenantId} (admin) — exclui tenant (cascade + RAG).
export const DELETE = route<{ tenantId: string }>(async (req, { tenantId }) => {
  requirePlatformAdmin(req);
  return json(await getTenantService().delete(tenantId));
});
