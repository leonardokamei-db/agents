import { NextResponse } from "next/server";

import * as config from "@/server/config";
import { TenantRepository } from "@/server/repositories/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /health — status, modelo e tenants (healthcheck do Railway).
export async function GET() {
  try {
    const tenants = await new TenantRepository().list();
    return NextResponse.json({ status: "ok", model: config.ANTHROPIC_MODEL, tenants: tenants.map((t) => t.id) });
  } catch {
    return NextResponse.json({ status: "ok", model: config.ANTHROPIC_MODEL, tenants: [] });
  }
}
