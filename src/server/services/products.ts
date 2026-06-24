/**
 * ProductService (porta `app/services/products.py`): GET em qualquer modo;
 * escrita só no modo "internal" (a checagem mora aqui, não no router).
 */

import * as catalog from "../catalog";
import type { AgentConfig, ProductRow } from "../domain";
import { NotFoundError, ValidationError } from "../errors";
import type { ProductCreateInput } from "../schemas";

export class ProductService {
  list(agent: AgentConfig): Promise<ProductRow[]> {
    return catalog.listProducts(agent);
  }

  create(agent: AgentConfig, data: ProductCreateInput): Promise<ProductRow> {
    ProductService.requireInternal(agent);
    return catalog.createProduct(agent.id, data);
  }

  async update(agent: AgentConfig, productId: number, changes: Partial<ProductCreateInput>): Promise<ProductRow> {
    ProductService.requireInternal(agent);
    const product = await catalog.updateProduct(agent.id, productId, changes);
    if (product === null) throw new NotFoundError("Produto não encontrado.");
    return product;
  }

  async delete(agent: AgentConfig, productId: number): Promise<void> {
    ProductService.requireInternal(agent);
    if (!(await catalog.deleteProduct(agent.id, productId))) {
      throw new NotFoundError("Produto não encontrado.");
    }
  }

  private static requireInternal(agent: AgentConfig): void {
    if (agent.productMode !== "internal") {
      throw new ValidationError(
        `Este agente não usa catálogo interno (product_mode=${JSON.stringify(agent.productMode)}). ` +
          "Mude o modo na configuração para gerenciar produtos aqui.",
      );
    }
  }
}
