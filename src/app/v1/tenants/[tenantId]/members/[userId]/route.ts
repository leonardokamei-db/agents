import { requireOwner } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { getTenantService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /v1/tenants/{tenantId}/members/{userId} (owner) — remove membro.
export const DELETE = route<{ tenantId: string; userId: string }>(async (req, { tenantId, userId }) => {
  await requireOwner(req, tenantId);
  await getTenantService().removeMember(tenantId, userId);
  return json({ removed: userId });
});
