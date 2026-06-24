/**
 * Skills de catálogo (porta `app/skills/catalog.py`). Cada skill consulta o
 * catálogo do agente (interno ou externo) via `../catalog`. O modelo NUNCA
 * inventa preço/estoque.
 */

import { z } from "zod";

import * as catalog from "../catalog";
import { CATEGORY_CATALOG, registerLocal, SkillResult } from "./base";

const checkStockArgs = z.object({ product_name: z.string(), quantity: z.number().int() });
const searchProductsArgs = z.object({ query: z.string() });
const listProductsArgs = z.object({});
const reserveStockArgs = z.object({ product_name: z.string(), quantity: z.number().int() });
const checkCatalogArgs = z.object({});

registerLocal(
  "check_stock",
  "Verifica estoque e preço total de um produto para uma quantidade.",
  checkStockArgs,
  async (ctx, a) => new SkillResult({ data: await catalog.checkStock(ctx.agent, a.product_name, a.quantity) }),
  CATEGORY_CATALOG,
);

registerLocal(
  "search_products",
  "Busca produtos por nome ou descrição quando o nome exato é incerto.",
  searchProductsArgs,
  async (ctx, a) => new SkillResult({ data: await catalog.searchProducts(ctx.agent, a.query) }),
  CATEGORY_CATALOG,
);

registerLocal(
  "list_products",
  "Lista todos os produtos do catálogo com preço e estoque.",
  listProductsArgs,
  async (ctx) => new SkillResult({ data: await catalog.listProducts(ctx.agent) }),
  CATEGORY_CATALOG,
);

registerLocal(
  "check_catalog",
  "Verifica o catálogo do cliente: como está configurado (interno/externo) " +
    "e se está acessível. Use para diagnosticar a integração de produtos.",
  checkCatalogArgs,
  async (ctx) => new SkillResult({ data: await catalog.catalogHealth(ctx.agent) }),
  CATEGORY_CATALOG,
);

registerLocal(
  "reserve_stock",
  "Reserva estoque de um pedido. Use APENAS após confirmação explícita de compra.",
  reserveStockArgs,
  async (ctx, a) => {
    const result = await catalog.reserveStock(ctx.agent, a.product_name, a.quantity);
    // Reserva concluída == compra registrada -> handoff para pagamento.
    // Falha de validação NÃO faz handoff (o modelo ainda pode esclarecer).
    if (result.success === true) {
      return new SkillResult({
        data: result,
        handoff: true,
        handoffReason: "Pedido confirmado — encaminhar para pagamento.",
      });
    }
    return new SkillResult({ data: result });
  },
  CATEGORY_CATALOG,
);
