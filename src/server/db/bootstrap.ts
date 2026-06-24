/**
 * Bootstrap do banco (porta `init_db`/`init_rag_db` + `_bootstrap` do Python).
 *
 *   - ensureSchema(): cria a extensão pgvector e as tabelas (idempotente).
 *   - bootstrap(): garante o tenant `default` e, em banco vazio, semeia o agente
 *     demo (desligue com SEED_DEMO=0). Greenfield: sem migração de bancos legados.
 *
 * Roda em deploy via `scripts/setup-db.ts` (e local via `npm run db:setup`).
 */

import * as config from "../config";
import { getLogger } from "../logging";
import { getSqlClient } from "./client";
import { EXTENSION_SQL, SCHEMA_SQL } from "./ddl";

const log = getLogger("blip-agent.bootstrap");

const DEMO_PRODUCTS = [
  { name: "Smartphone Galaxy A55", description: 'Smartphone 5G, 256GB, tela AMOLED 6.6"', price: 1899.9, stock: 12 },
  { name: "Notebook Ideapad 3", description: 'Notebook 15.6", Ryzen 5, 8GB RAM, SSD 512GB', price: 3299.0, stock: 5 },
  { name: "Fone Bluetooth JBL Tune", description: "Fone over-ear sem fio, bateria 40h", price: 299.9, stock: 2 },
  { name: 'Smart TV 50" 4K', description: "Smart TV LED 50 polegadas, 4K, Wi-Fi", price: 2499.0, stock: 0 },
  { name: "Mouse Gamer RGB", description: "Mouse óptico 7200 DPI com iluminação RGB", price: 149.9, stock: 30 },
];

/** Cria a extensão pgvector e o schema (idempotente). */
export async function ensureSchema(): Promise<void> {
  const sql = getSqlClient();
  await sql.unsafe(EXTENSION_SQL);
  await sql.unsafe(SCHEMA_SQL);
  log.info("Schema garantido (extensão pgvector + tabelas).");
}

/** Garante o tenant default e semeia o agente demo (em banco vazio). */
export async function bootstrap(): Promise<void> {
  // Import dinâmico: services dependem do schema já existir.
  const { getTenantService, getAgentService } = await import("../services");
  const catalog = await import("../catalog");
  const { AgentRepository } = await import("../repositories/agents");

  await getTenantService().ensureDefaultTenant();

  if (!config.SEED_DEMO) return;
  const repo = new AgentRepository();
  if ((await repo.listForTenant(config.DEFAULT_TENANT_ID)).length > 0) return;

  const demo = await getAgentService().create(config.DEFAULT_TENANT_ID, {
    slug: "demo",
    name: "Loja Demo",
    systemPrompt: "",
    businessRules:
      "Troca em até 7 dias com nota fiscal. Reembolso se a entrega atrasar " +
      "mais de 7 dias. Para defeitos, oriente sobre a garantia antes de escalar.",
    maxTurns: 15,
    productMode: "internal",
    productApiUrl: "",
    productApiKey: "",
    ragEnabled: true,
    externalProducts: true,
    skills: [],
  });

  for (const p of DEMO_PRODUCTS) {
    await catalog.createProduct(demo.id, { ...p, unit: "unidade" });
  }
  log.info(`Agente demo criado: tenant=${demo.tenantId} slug=${demo.slug} id=${demo.id}`);
}
