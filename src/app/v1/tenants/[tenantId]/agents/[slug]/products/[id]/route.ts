import { requireMember } from "@/server/http/auth";
import { ValidationError } from "@/server/errors";
import { json, parseBody, route } from "@/server/http/route";
import { productInfo } from "@/server/http/serialize";
import { productUpdateSchema, toProductUpdate } from "@/server/schemas";
import { getAgentService, getProductService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number {
  const id = Number.parseInt(raw, 10);
  if (Number.isNaN(id)) throw new ValidationError("ID de produto inválido.");
  return id;
}

// PUT .../products/{id} (member; só no modo interno) — edita produto.
export const PUT = route<{ tenantId: string; slug: string; id: string }>(async (req, { tenantId, slug, id }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  const input = await parseBody(req, productUpdateSchema);
  const updated = await getProductService().update(agent, parseId(id), toProductUpdate(input));
  return json(productInfo(updated));
});

// DELETE .../products/{id} (member; só no modo interno) — remove produto.
export const DELETE = route<{ tenantId: string; slug: string; id: string }>(async (req, { tenantId, slug, id }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);
  await getProductService().delete(agent, parseId(id));
  return json({ deleted: parseId(id) });
});
