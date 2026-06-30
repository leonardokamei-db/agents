import { requireMember } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { skillInfo } from "@/server/http/serialize";
import { skillsCatalog } from "@/server/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v1/tenants/{tenantId}/skills (member) — catálogo de skills disponíveis com
// suas descrições (a MESMA que o LLM lê), para o time de UX decidir quais habilitar.
// O conjunto é global; o caminho é escopado ao tenant só para reusar o RBAC.
export const GET = route<{ tenantId: string }>(async (req, { tenantId }) => {
  await requireMember(req, tenantId);
  return json(skillsCatalog().map(skillInfo));
});
