/**
 * Wrapper único de rota (porta o middleware + exception handlers de `app/main.py`).
 *
 *   - abre o escopo de log (requestId + tenant) via AsyncLocalStorage;
 *   - serializa AppError com o status tipado, ZodError -> 400, resto -> 500;
 *   - devolve X-Request-ID no header da resposta.
 */

import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { AppError } from "../errors";
import { getLogger, runWithLogContext, tenantFromPath } from "../logging";

const log = getLogger("blip-agent");

type Params = Record<string, string>;
type Handler<P extends Params> = (req: NextRequest, params: P) => Promise<Response> | Response;

export function route<P extends Params = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const params = ((await segment.params) ?? {}) as P;
    const requestId = req.headers.get("x-request-id") || randomUUID().replace(/-/g, "").slice(0, 12);
    const tenant = (params as Params).tenantId ?? tenantFromPath(new URL(req.url).pathname);

    return runWithLogContext({ requestId, tenant }, async () => {
      let res: Response;
      try {
        res = await handler(req, params);
      } catch (e) {
        res = errorResponse(e);
      }
      res.headers.set("X-Request-ID", requestId);
      return res;
    });
  };
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof AppError) {
    return NextResponse.json({ code: e.code, detail: e.detail }, { status: e.statusCode });
  }
  if (e instanceof ZodError) {
    const detail = e.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    return NextResponse.json({ code: "validation_error", detail }, { status: 400 });
  }
  log.exception("Erro não tratado:", e);
  return NextResponse.json({ code: "internal_error", detail: "Erro interno." }, { status: 500 });
}

/**
 * Lê e valida o corpo JSON com um schema Zod (lança ZodError -> 400).
 * Genérico sobre o schema (não sobre T) para inferir o tipo de SAÍDA (defaults
 * aplicados) — senão `T` vincularia ao input e campos com `.default()` ficariam
 * opcionais (`... | undefined`) no resultado.
 */
export async function parseBody<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  return schema.parse(raw) as z.output<S>;
}

/** Resposta JSON com status (default 200). */
export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}
