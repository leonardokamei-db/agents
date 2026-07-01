"use client";

/**
 * Dashboard do time de dados. Página standalone (mesma origem da API, sem CORS).
 * Lê GET /v1/tenants/{tenant}/analytics e mostra KPIs, gráficos e logs recentes.
 * Orquestrador: detém o estado/fetch; a visualização vem de `@/components/dashboard/*`.
 *
 * Autenticação: X-API-Key = chave do tenant OU a X-Admin-Key (superusuária). A chave
 * fica no localStorage (compartilhada com o painel admin em "/").
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { BarList } from "@/components/dashboard/BarList";
import { DayChart } from "@/components/dashboard/DayChart";
import { Kpis } from "@/components/dashboard/Kpis";
import { RecentTable } from "@/components/dashboard/RecentTable";
import type { AgentLite, Dashboard } from "@/components/dashboard/types";
import { apiFetch } from "@/lib/api";

const authHeaders = (key: string) => ({ "X-Admin-Key": key, "X-API-Key": key });

export default function DashboardPage() {
  const [key, setKey] = useState("");
  const keyRef = useRef("");
  const [tenant, setTenant] = useState("");
  const [days, setDays] = useState(30);
  const [agentSlug, setAgentSlug] = useState("");
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const api = useCallback((path: string) => apiFetch(path, {}, authHeaders(keyRef.current)), []);

  const loadAgents = useCallback(
    async (tid: string) => {
      try {
        const list: AgentLite[] = await api(`/v1/tenants/${tid}/agents`);
        setAgents(list);
      } catch {
        setAgents([]);
      }
    },
    [api],
  );

  const load = useCallback(async () => {
    if (!tenant.trim()) return setError("Informe o tenant.");
    keyRef.current = key.trim();
    localStorage.setItem("blip_admin_key", key.trim());
    localStorage.setItem("blip_dash_tenant", tenant.trim());
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ days: String(days) });
      if (agentSlug) q.set("agent", agentSlug);
      const d: Dashboard = await api(`/v1/tenants/${tenant.trim()}/analytics?${q.toString()}`);
      setData(d);
      void loadAgents(tenant.trim());
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [api, key, tenant, days, agentSlug, loadAgents]);

  // Restaura chave/tenant salvos e carrega automaticamente.
  useEffect(() => {
    const savedKey = localStorage.getItem("blip_admin_key") || "";
    const savedTenant = localStorage.getItem("blip_dash_tenant") || "";
    setKey(savedKey);
    setTenant(savedTenant);
    keyRef.current = savedKey;
    if (savedKey && savedTenant) {
      setLoading(true);
      apiFetch(`/v1/tenants/${savedTenant}/analytics?days=30`, {}, authHeaders(savedKey))
        .then((d: Dashboard) => {
          setData(d);
          void loadAgents(savedTenant);
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header>
        <h1>Blip Agent — Dashboard de dados</h1>
        <a className="btn small secondary" href="/" style={{ textDecoration: "none" }}>
          ← Painel
        </a>
      </header>

      <div className="dash">
        <div className="controls">
          <div className="field">
            <label>Chave (tenant ou admin)</label>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="X-API-Key" />
          </div>
          <div className="field">
            <label>Tenant</label>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="default" />
          </div>
          <div className="field">
            <label>Período</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Últimos 7 dias</option>
              <option value={30}>Últimos 30 dias</option>
              <option value={90}>Últimos 90 dias</option>
              <option value={365}>Último ano</option>
            </select>
          </div>
          <div className="field">
            <label>Agente</label>
            <select value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)}>
              <option value="">Todos os agentes</option>
              {agents.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name} ({a.slug})
                </option>
              ))}
            </select>
          </div>
          <button className="btn" style={{ marginTop: 0 }} onClick={load} disabled={loading}>
            {loading ? "Carregando..." : "Atualizar"}
          </button>
        </div>

        {error && (
          <div className="toast error" style={{ position: "static", marginBottom: 16 }}>
            {error}
          </div>
        )}

        {!data && !error && <div className="empty">Informe a chave e o tenant e clique em Atualizar.</div>}

        {data && (
          <>
            <Kpis summary={data.summary} />

            <div className="charts">
              <div className="chart-card">
                <h3>Interações por dia</h3>
                <DayChart points={data.by_day} />
                <div className="legend">
                  <span>
                    <i style={{ background: "var(--accent)" }} /> sem transbordo
                  </span>
                  <span>
                    <i style={{ background: "var(--warn)" }} /> transbordo
                  </span>
                </div>
              </div>
              <div className="chart-card">
                <h3>Por intenção (intent)</h3>
                <BarList items={data.by_intent} />
              </div>
              <div className="chart-card">
                <h3>Por origem da resposta (source)</h3>
                <BarList items={data.by_source} />
              </div>
              <div className="chart-card">
                <h3>Skills mais usadas</h3>
                <BarList items={data.top_tools} empty="Nenhuma skill registrada no período." />
              </div>
              {data.by_agent.length > 1 && (
                <div className="chart-card">
                  <h3>Por agente</h3>
                  <BarList items={data.by_agent.map((a) => ({ label: a.slug, count: a.count }))} />
                </div>
              )}
            </div>

            <RecentTable recent={data.recent} />
          </>
        )}
      </div>
    </>
  );
}
