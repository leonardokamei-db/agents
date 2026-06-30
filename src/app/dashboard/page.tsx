"use client";

/**
 * Dashboard do time de dados. Página standalone (mesma origem da API, sem CORS).
 * Lê GET /v1/tenants/{tenant}/analytics e mostra KPIs de transbordo/sucesso/tokens,
 * gráficos (série por dia, intents, sources, skills, por agente) e os logs recentes.
 *
 * Autenticação: X-API-Key = chave do tenant OU a X-Admin-Key (superusuária). A chave
 * fica no localStorage (compartilhada com o painel admin em "/").
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Summary {
  total: number;
  handoff_count: number;
  success_no_handoff: number;
  handoff_rate: number;
  success_rate: number;
  tokens_total: number;
  tokens_avg: number;
}
interface DayPoint { day: string; count: number; handoffs: number; tokens: number }
interface LabelCount { label: string; count: number }
interface AgentRow { slug: string; agent_id: string; count: number; handoffs: number; tokens: number }
interface RecentRow {
  id: number;
  slug: string;
  intent: string;
  source: string;
  agent_used: string;
  tokens_used: number;
  should_handoff: boolean;
  handoff_reason: string;
  tools_called: string[];
  rag_chunks_used: number;
  created_at: string;
}
interface Dashboard {
  range: { days: number; since: string; agent_slug: string | null };
  summary: Summary;
  by_day: DayPoint[];
  by_intent: LabelCount[];
  by_source: LabelCount[];
  by_agent: AgentRow[];
  top_tools: LabelCount[];
  recent: RecentRow[];
}
interface AgentLite { slug: string; name: string }

const fmt = (n: number) => n.toLocaleString("pt-BR");

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

  const api = useCallback(async (path: string) => {
    const resp = await fetch(path, {
      headers: { "X-Admin-Key": keyRef.current, "X-API-Key": keyRef.current },
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        detail = (await resp.json()).detail || detail;
      } catch {
        /* corpo não-JSON */
      }
      throw new Error(detail);
    }
    return resp.json();
  }, []);

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
      keyRef.current = savedKey;
      setLoading(true);
      const q = new URLSearchParams({ days: "30" });
      fetch(`/v1/tenants/${savedTenant}/analytics?${q.toString()}`, {
        headers: { "X-Admin-Key": savedKey, "X-API-Key": savedKey },
      })
        .then(async (r) => {
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
          return r.json();
        })
        .then((d: Dashboard) => {
          setData(d);
          void loadAgents(savedTenant);
        })
        .catch((e) => setError(e.message))
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

        {error && <div className="toast error" style={{ position: "static", marginBottom: 16 }}>{error}</div>}

        {!data && !error && <div className="empty">Informe a chave e o tenant e clique em Atualizar.</div>}

        {data && (
          <>
            <div className="kpis">
              <div className="kpi accent">
                <div className="num">{fmt(data.summary.total)}</div>
                <div className="lbl">Interações no período</div>
              </div>
              <div className="kpi warn">
                <div className="num">{data.summary.handoff_rate}%</div>
                <div className="lbl">Transbordo ({fmt(data.summary.handoff_count)} interações)</div>
              </div>
              <div className="kpi ok">
                <div className="num">{data.summary.success_rate}%</div>
                <div className="lbl">Sucesso sem transbordo ({fmt(data.summary.success_no_handoff)})</div>
              </div>
              <div className="kpi">
                <div className="num">{fmt(data.summary.tokens_total)}</div>
                <div className="lbl">Tokens consumidos</div>
              </div>
              <div className="kpi">
                <div className="num">{fmt(data.summary.tokens_avg)}</div>
                <div className="lbl">Tokens / interação (média)</div>
              </div>
            </div>

            <div className="charts">
              <div className="chart-card">
                <h3>Interações por dia</h3>
                <DayChart points={data.by_day} />
                <div className="legend">
                  <span><i style={{ background: "var(--accent)" }} /> sem transbordo</span>
                  <span><i style={{ background: "var(--warn)" }} /> transbordo</span>
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

            <div className="chart-card">
              <h3>Logs recentes ({data.recent.length})</h3>
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
                    {data.recent.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="empty">Sem interações no período.</td>
                      </tr>
                    ) : (
                      data.recent.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.created_at).toLocaleString("pt-BR")}</td>
                          <td>{r.slug}</td>
                          <td>{r.intent || "—"}</td>
                          <td>{r.source || "—"}</td>
                          <td>{fmt(r.tokens_used)}</td>
                          <td>{r.tools_called.length ? r.tools_called.join(", ") : "—"}</td>
                          <td>
                            {r.should_handoff ? (
                              <span className="pill ho" title={r.handoff_reason}>transbordo</span>
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
          </>
        )}
      </div>
    </>
  );
}

function BarList({ items, empty }: { items: LabelCount[]; empty?: string }) {
  if (items.length === 0) return <div className="empty" style={{ padding: 12 }}>{empty || "Sem dados."}</div>;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <>
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <div className="bar-label" title={i.label}>{i.label}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(i.count / max) * 100}%` }} />
          </div>
          <div className="bar-val">{fmt(i.count)}</div>
        </div>
      ))}
    </>
  );
}

function DayChart({ points }: { points: DayPoint[] }) {
  if (points.length === 0) return <div className="empty" style={{ padding: 12 }}>Sem dados no período.</div>;
  const max = Math.max(...points.map((p) => p.count), 1);
  // Mostra no máximo ~20 rótulos para não poluir o eixo.
  const labelEvery = Math.ceil(points.length / 20);
  return (
    <div className="day-chart">
      {points.map((p, idx) => {
        const h = (p.count / max) * 100;
        const hoFrac = p.count > 0 ? p.handoffs / p.count : 0;
        return (
          <div className="day-col" key={p.day} title={`${p.day}: ${p.count} interações, ${p.handoffs} transbordo, ${p.tokens} tokens`}>
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
