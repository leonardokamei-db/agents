import { requireMember } from "@/server/http/auth";
import { json, route } from "@/server/http/route";
import { ValidationError } from "@/server/errors";
import { getAgentService, getKnowledgeService } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST .../knowledge/pdf (member) — sobe um PDF e ingere (síncrono -> 200 com chunks_created).
export const POST = route<{ tenantId: string; slug: string }>(async (req, { tenantId, slug }) => {
  await requireMember(req, tenantId);
  const agent = await getAgentService().get(tenantId, slug);

  const form = await req.formData();
  const sourceName = String(form.get("source_name") ?? "").trim();
  const file = form.get("file");
  if (!sourceName) throw new ValidationError("Informe o source_name.");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) {
    throw new ValidationError("Apenas arquivos PDF são aceitos.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await getKnowledgeService().ingestPdf(agent, bytes, sourceName);
  return json(result);
});
