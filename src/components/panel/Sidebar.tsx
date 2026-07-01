"use client";

import type { AgentPublic, TenantPublic } from "./types";

/** Coluna esquerda: seletor de tenant + lista de agentes + ações de criação. */
export function Sidebar({
  tenants,
  currentTenantId,
  onSelectTenant,
  onNewTenant,
  agents,
  current,
  onSelectAgent,
  onNewAgent,
}: {
  tenants: TenantPublic[];
  currentTenantId: string | null;
  onSelectTenant: (id: string) => void;
  onNewTenant: () => void;
  agents: AgentPublic[];
  current: AgentPublic | null;
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
}) {
  return (
    <aside>
      <div className="side-head">Tenant</div>
      <div className="side-sub">
        <select value={currentTenantId ?? ""} onChange={(e) => onSelectTenant(e.target.value)}>
          {tenants.length === 0 ? (
            <option value="">— conecte —</option>
          ) : (
            tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.id})
              </option>
            ))
          )}
        </select>
        <button className="btn secondary small" style={{ width: "100%", marginTop: 8 }} onClick={onNewTenant}>
          + Novo tenant
        </button>
      </div>
      <div className="side-head">Agentes</div>
      <div className="agent-list">
        {!currentTenantId ? (
          <div className="empty">Selecione um tenant.</div>
        ) : agents.length === 0 ? (
          <div className="empty">Nenhum agente. Crie um!</div>
        ) : (
          agents.map((a) => (
            <div
              key={a.id}
              className={"agent-item" + (current?.id === a.id ? " active" : "")}
              onClick={() => onSelectAgent(a.id)}
            >
              <div>{a.name}</div>
              <div className="aid">{a.slug}</div>
            </div>
          ))
        )}
      </div>
      <div className="side-foot">
        <button className="btn secondary small" style={{ width: "100%" }} onClick={onNewAgent}>
          + Novo agente
        </button>
      </div>
    </aside>
  );
}
