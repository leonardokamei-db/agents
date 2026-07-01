"use client";

import { fmt } from "./format";
import type { RecentRow } from "./types";

/** Tabela dos logs recentes de interação (os "últimos eventos" do dashboard). */
export function RecentTable({ recent }: { recent: RecentRow[] }) {
  return (
    <div className="chart-card">
      <h3>Logs recentes ({recent.length})</h3>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Agente</th>
              <th>Intent</th>
              <th>Origem</th>
              <th>Tokens</th>
              <th>Skills</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  Sem interações no período.
                </td>
              </tr>
            ) : (
              recent.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString("pt-BR")}</td>
                  <td>{r.slug}</td>
                  <td>{r.intent || "—"}</td>
                  <td>{r.source || "—"}</td>
                  <td>{fmt(r.tokens_used)}</td>
                  <td>{r.tools_called.length ? r.tools_called.join(", ") : "—"}</td>
                  <td>
                    {r.should_handoff ? (
                      <span className="pill ho" title={r.handoff_reason}>
                        transbordo
                      </span>
                    ) : (
                      <span className="pill">ok</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
