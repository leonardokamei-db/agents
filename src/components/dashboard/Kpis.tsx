"use client";

import { fmt } from "./format";
import type { Summary } from "./types";

/** Cartões de KPI: total, transbordo, sucesso, tokens totais e médios. */
export function Kpis({ summary }: { summary: Summary }) {
  return (
    <div className="kpis">
      <div className="kpi accent">
        <div className="num">{fmt(summary.total)}</div>
        <div className="lbl">Interações no período</div>
      </div>
      <div className="kpi warn">
        <div className="num">{summary.handoff_rate}%</div>
        <div className="lbl">Transbordo ({fmt(summary.handoff_count)} interações)</div>
      </div>
      <div className="kpi ok">
        <div className="num">{summary.success_rate}%</div>
        <div className="lbl">Sucesso sem transbordo ({fmt(summary.success_no_handoff)})</div>
      </div>
      <div className="kpi">
        <div className="num">{fmt(summary.tokens_total)}</div>
        <div className="lbl">Tokens consumidos</div>
      </div>
      <div className="kpi">
        <div className="num">{fmt(summary.tokens_avg)}</div>
        <div className="lbl">Tokens / interação (média)</div>
      </div>
    </div>
  );
}
