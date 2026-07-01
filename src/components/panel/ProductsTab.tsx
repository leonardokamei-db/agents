"use client";

import { type FormEvent } from "react";

import { InternalProductRow } from "./InternalProductRow";
import type { AgentPublic, Product } from "./types";

/** Aba de produtos: form (só modo interno) + tabela do catálogo. */
export function ProductsTab({
  agent,
  products,
  onAddProduct,
  onSaveProduct,
  onDeleteProduct,
}: {
  agent: AgentPublic;
  products: Product[];
  onAddProduct: (e: FormEvent<HTMLFormElement>) => void;
  onSaveProduct: (p: Product, price: number, stock: number) => void;
  onDeleteProduct: (id: number) => void;
}) {
  return (
    <div className="tab-body">
      {agent.product_mode === "internal" && (
        <div className="form-card">
          <h2>Adicionar produto</h2>
          <form onSubmit={onAddProduct}>
            <div className="row2">
              <div>
                <label>Nome *</label>
                <input name="name" />
              </div>
              <div>
                <label>Descrição</label>
                <input name="description" />
              </div>
            </div>
            <div className="row2">
              <div>
                <label>Preço (R$) *</label>
                <input name="price" type="number" step="0.01" />
              </div>
              <div>
                <label>Estoque</label>
                <input name="stock" type="number" defaultValue={0} />
              </div>
            </div>
            <button className="btn" type="submit">
              Adicionar
            </button>
          </form>
        </div>
      )}
      <div className="form-card">
        <h2>
          Catálogo{" "}
          <span className="badge">
            {agent.product_mode === "external"
              ? "API externa: " + (agent.product_api_url || "(sem URL)")
              : agent.product_mode === "internal"
                ? "catálogo interno"
                : "sem produtos"}
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Produto</th>
              <th>Preço</th>
              <th>Estoque</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) =>
              agent.product_mode === "internal" ? (
                <InternalProductRow key={p.id} product={p} onSave={onSaveProduct} onDelete={onDeleteProduct} />
              ) : (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <br />
                    <span style={{ color: "var(--muted)", fontSize: 11 }}>{p.description || ""}</span>
                  </td>
                  <td>R$ {Number(p.price).toFixed(2)}</td>
                  <td>{p.stock}</td>
                  <td></td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {products.length === 0 && <div className="empty">Nenhum produto.</div>}
      </div>
    </div>
  );
}
