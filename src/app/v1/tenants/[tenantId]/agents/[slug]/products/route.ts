import { requireMember } from "@/server/http/auth";
import { json, parseBody, route } from "@/server/http/route";
import { productInfo } from "@/server/http/serialize";
import { productCreateSchema } from "@/server/schemas";
import { getAgentService, getProductService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET .../products (member) — lista o catálogo (interno ou externo).
export const GET = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const list = await getProductService().list(agent);
  return json(list.map(productInfo));
});

// POST .../products (member; só no modo interno) — adiciona produto.
export const POST = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const input = await parseBody(req, productCreateSchema);
  const created = await getProductService().create(agent, input);
  return json(productInfo(created), 201);
});
