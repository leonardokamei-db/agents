"use client";

import { useState } from "react";

import type { Product } from "./types";

/** Linha editável (preço/estoque) do catálogo interno. */
export function InternalProductRow({
  product,
  onSave,
  onDelete,
}: {
  product: Product;
  onSave: (p: Product, price: number, stock: number) => void;
  onDelete: (id: number) => void;
}) {
  const [price, setPrice] = useState(String(product.price));
  const [stock, setStock] = useState(String(product.stock));
  return (
    <tr>
      <td>
        {product.name}
        <br />
        <span style={{ color: "var(--muted)", fontSize: 11 }}>{product.description || ""}</span>
      </td>
      <td>
        <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
      </td>
      <td>
        <input type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
      </td>
      <td>
        <button className="btn small" onClick={() => onSave(product, parseFloat(price), parseInt(stock))}>
          Salvar
        </button>
        <button className="btn danger small" style={{ marginLeft: 6 }} onClick={() => onDelete(product.id)}>
          ✕
        </button>
      </td>
    </tr>
  );
}
