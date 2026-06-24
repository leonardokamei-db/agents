/**
 * Repositório de produtos (porta `app/repositories/products.py`).
 *
 * INVARIANTE DE TENANCY: todo método recebe `agentId` e SEMPRE aplica
 * `WHERE agent_id = ?` — isolamento entre tenants vira garantia da classe.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "../db/client";
import { products } from "../db/schema";
import type { ProductRow } from "../domain";
import type { ProductCreateInput } from "../schemas";

type ProductDbRow = typeof products.$inferSelect;

/** Erro de estoque (produto inexistente / estoque insuficiente). */
export class StockError extends Error {}

function toProductRow(r: ProductDbRow): ProductRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    price: r.price,
    stock: r.stock,
    unit: r.unit ?? "unidade",
  };
}

const EDITABLE = ["name", "description", "price", "stock", "unit"] as const;

export class ProductRepository {
  async listForAgent(agentId: string): Promise<ProductRow[]> {
    const rows = await db
      .select()
      .from(products)
      .where(eq(products.agentId, agentId))
      .orderBy(asc(products.name));
    return rows.map(toProductRow);
  }

  async get(agentId: string, productId: number): Promise<ProductRow | null> {
    const rows = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.agentId, agentId)))
      .limit(1);
    return rows[0] ? toProductRow(rows[0]) : null;
  }

  async create(agentId: string, data: ProductCreateInput): Promise<ProductRow> {
    const inserted = await db
      .insert(products)
      .values({
        agentId,
        name: data.name,
        description: data.description ?? "",
        price: data.price,
        stock: data.stock ?? 0,
        unit: data.unit ?? "unidade",
      })
      .returning();
    return toProductRow(inserted[0]);
  }

  async update(
    agentId: string,
    productId: number,
    changes: Partial<ProductCreateInput>,
  ): Promise<ProductRow | null> {
    const set: Partial<typeof products.$inferInsert> = {};
    for (const key of EDITABLE) {
      const value = changes[key];
      if (value !== undefined) (set as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(set).length > 0) {
      await db
        .update(products)
        .set(set)
        .where(and(eq(products.id, productId), eq(products.agentId, agentId)));
    }
    return this.get(agentId, productId);
  }

  async delete(agentId: string, productId: number): Promise<boolean> {
    const deleted = await db
      .delete(products)
      .where(and(eq(products.id, productId), eq(products.agentId, agentId)))
      .returning({ id: products.id });
    return deleted.length > 0;
  }

  /**
   * Decrementa o estoque atomicamente (transação: relê dentro). Lança StockError
   * se o produto sumiu ou se o estoque é insuficiente — o catalog traduz.
   */
  async decrementStock(agentId: string, productId: number, quantity: number): Promise<ProductRow> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.agentId, agentId)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new StockError("Produto não encontrado.");
      if (row.stock < quantity) throw new StockError(`Estoque insuficiente (disponível: ${row.stock}).`);
      const updated = await tx
        .update(products)
        .set({ stock: row.stock - quantity })
        .where(and(eq(products.id, productId), eq(products.agentId, agentId)))
        .returning();
      return toProductRow(updated[0]);
    });
  }
}
