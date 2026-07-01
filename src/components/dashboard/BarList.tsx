"use client";

import { fmt } from "./format";
import type { LabelCount } from "./types";

/** Lista de barras horizontais proporcional ao maior valor. */
export function BarList({ items, empty }: { items: LabelCount[]; empty?: string }) {
  if (items.length === 0) {
    return (
      <div className="empty" style={{ padding: 12 }}>
        {empty || "Sem dados."}
      </div>
    );
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <>
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <div className="bar-label" title={i.label}>
            {i.label}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.count / max) * 100}%` }} />
          </div>
          <div className="bar-val">{fmt(i.count)}</div>
        </div>
      ))}
    </>
  );
}
