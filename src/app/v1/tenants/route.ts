import { requirePlatformAdmin } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { tenantCreated, tenantPublic } from "@/server/http/serialize";
import { tenantCreateSchema, toTenantCreate } from "@/server/schemas";
import { getTenantService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants (admin) — lista tenants (sem segredos).
export const GET = route(async (req) => {
  requirePlatformAdmin(req);
  const list = await getTenantService().list();
  return json(list.map(tenantPublic));
});

// POST /v1/tenants (admin) — cria tenant -> api_key + owner (chaves exibidas 1x).
export const POST = route(async (req) => {
  requirePlatformAdmin(req);
  const input = await parseBody(req, tenantCreateSchema);
  const { tenant, owner } = await getTenantService().create(toTenantCreate(input));
  return json(tenantCreated(tenant, owner), 201);
});
