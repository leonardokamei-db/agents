"use client";

import type { DayPoint } from "./types";

/** Barras empilhadas por dia (transbordo vs. sucesso), com rótulos ralos no eixo. */
export function DayChart({ points }: { points: DayPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="empty" style={{ padding: 12 }}>
        Sem dados no período.
      </div>
    );
  }
  const max = Math.max(...points.map((p) => p.count), 1);
  // Mostra no máximo ~20 rótulos para não poluir o eixo.
  const labelEvery = Math.ceil(points.length / 20);
  return (
    <div className="day-chart">
      {points.map((p, idx) => {
        const h = (p.count / max) * 100;
        const hoFrac = p.count > 0 ? p.handoffs / p.count : 0;
        return (
          <div
            className="day-col"
            key={p.day}
            title={`${p.day}: ${p.count} interações, ${p.handoffs} transbordo, ${p.tokens} tokens`}
          >
            <div className="stack" style={{ height: "100%" }}>
              <div style={{ height: `${h}%`, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                <div className="seg-ho" style={{ height: `${hoFrac * 100}%`, background: "var(--warn)" }} />
                <div className="seg-ok" style={{ flex: 1 }} />
              </div>
            </div>
            <div className="tick">{idx % labelEvery === 0 ? p.day.slice(5) : ""}</div>
          </div>
        );
      })}
    </div>
  );
}
