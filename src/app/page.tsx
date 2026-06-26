"use client";

/**
 * Painel admin (porta `client.html` para React). Mesma origem da API (sem CORS).
 * A X-Admin-Key autentica rotas de plataforma e, como X-API-Key, também as de
 * tenant (admin = superusuário). Mantém todos os fluxos do painel original.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const SKILLS_LIST = [
  "knowledge_search",
  "check_stock",
  "search_products",
  "list_products",
  "reserve_stock",
  "check_catalog",
  "escalate_to_human",
  "create_ticket",
];

interface TenantPublic {
  id: string;
  name: string;
  created_at: string;
}
interface TenantCreated extends TenantPublic {
  api_key: string;
  owner_email: string;
  owner_api_key: string;
}
interface AgentPublic {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  system_prompt: string;
  business_rules: string;
  max_turns: number;
  product_mode: "none" | "internal" | "external";
  product_api_url: string;
  rag_enabled: boolean;
  external_products: boolean;
  skills: string[];
  endpoint: string;
  created_at: string;
}
interface ChatMeta {
  agent_used: string;
  intent: string;
  confidence: number;
  source: string;
  tokens_used: number;
  rag_chunks_used: number;
  tools_called: string[];
  should_handoff: boolean;
  response: string;
}
interface ChatMsg {
  role: "user" | "bot";
  text: string;
  meta?: ChatMeta;
}
interface SourceInfo {
  source_name: string;
  chunk_count: number;
  last_updated: string;
}
interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  unit: string;
}
interface Member {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

type View = "chat" | "config" | "knowledge" | "products" | "members" | "createTenant" | "createAgent";

export default function Panel() {
  const [adminKey, setAdminKey] = useState("");
  const adminKeyRef = useRef("");
  const [tenants, setTenants] = useState<TenantPublic[]>([]);
  const [tenantKeys, setTenantKeys] = useState<Record<string, string>>({});
  const [currentTenantId, setCurrentTenantId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentPublic[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const historyRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [toastMsg, setToastMsg] = useState<{ msg: string; error: boolean } | null>(null);
  const [tenantCreated, setTenantCreated] = useState<TenantCreated | null>(null);
  const [memberCreated, setMemberCreated] = useState<Member & { api_key: string } | null>(null);

  const currentTenant = tenants.find((t) => t.id === currentTenantId) ?? null;
  const current = agents.find((a) => a.id === currentAgentId) ?? null;

  const toast = useCallback((msg: string, error = false) => {
    setToastMsg({ msg, error });
    setTimeout(() => setToastMsg(null), 4500);
  }, []);

  const api = useCallback(async (path: string, opts: RequestInit = {}, apiKey?: string | null) => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
    headers["X-Admin-Key"] = adminKeyRef.current;
    headers["X-API-Key"] = apiKey || adminKeyRef.current;
    if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const resp = await fetch(path, { ...opts, headers });
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        detail = (await resp.json()).detail || detail;
      } catch {
        /* corpo não-JSON */
      }
      throw new Error(detail);
    }
    return resp.status === 204 ? null : resp.json();
  }, []);

  const tid = () => currentTenantId;
  const chatKey = () => (currentTenantId && tenantKeys[currentTenantId]) || null;
  const agentBase = () => `/v1/tenants/${tid()}/agents/${current?.slug}`;

  // ---------------- Tenants ---------------- //

  const loadAgents = useCallback(
    async (tenantId: string) => {
      try {
        const list: AgentPublic[] = await api(`/v1/tenants/${tenantId}/agents`);
        setAgents(list);
      } catch (e) {
        toast("Falha ao listar agentes: " + (e as Error).message, true);
      }
    },
    [api, toast],
  );

  const selectTenant = useCallback(
    async (id: string) => {
      setCurrentTenantId(id || null);
      setCurrentAgentId(null);
      setView(null);
      if (id) await loadAgents(id);
      else setAgents([]);
    },
    [loadAgents],
  );

  const connect = useCallback(
    async (key: string) => {
      adminKeyRef.current = key;
      setAdminKey(key);
      localStorage.setItem("blip_admin_key", key);
      try {
        const ts: TenantPublic[] = await api("/v1/tenants");
        setTenants(ts);
        toast(`${ts.length} tenant(s) carregado(s).`);
        if (ts.length) await selectTenant(ts[0].id);
      } catch (e) {
        toast("Falha ao conectar: " + (e as Error).message, true);
      }
    },
    [api, toast, selectTenant],
  );

  useEffect(() => {
    const saved = localStorage.getItem("blip_admin_key") || "";
    if (saved) {
      setAdminKey(saved);
      void connect(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createTenant(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const t: TenantCreated = await api("/v1/tenants", {
        method: "POST",
        body: JSON.stringify({
          id: (fd.get("id") as string)?.trim() || null,
          name: (fd.get("name") as string).trim(),
          owner_email: (fd.get("owner_email") as string).trim(),
          owner_name: (fd.get("owner_name") as string).trim(),
        }),
      });
      setTenantKeys((prev) => ({ ...prev, [t.id]: t.api_key }));
      setTenantCreated(t);
      const ts: TenantPublic[] = await api("/v1/tenants");
      setTenants(ts);
      toast("Tenant criado: " + t.id);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  // ---------------- Agentes ---------------- //

  async function selectAgent(id: string) {
    setCurrentAgentId(id);
    historyRef.current = [];
    setMessages([]);
    setView("chat");
    const agent = agents.find((a) => a.id === id);
    if (agent) {
      await refreshSources(agent);
      await refreshProducts(agent);
    }
  }

  async function createAgent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const created: AgentPublic = await api(`/v1/tenants/${tid()}/agents`, {
        method: "POST",
        body: JSON.stringify({
          slug: (fd.get("slug") as string)?.trim() || null,
          name: (fd.get("name") as string).trim(),
          system_prompt: fd.get("system_prompt"),
          business_rules: fd.get("business_rules"),
          max_turns: parseInt(fd.get("max_turns") as string) || 15,
          product_mode: fd.get("product_mode"),
          product_api_url: (fd.get("product_api_url") as string).trim(),
          product_api_key: (fd.get("product_api_key") as string).trim(),
          rag_enabled: fd.get("rag_enabled") === "on",
          external_products: fd.get("external_products") === "on",
          skills: fd.getAll("skills") as string[],
        }),
      });
      await loadAgents(tid()!);
      toast("Agente criado: " + created.slug);
      setCurrentAgentId(created.id);
      setView("chat");
      historyRef.current = [];
      setMessages([]);
      void refreshSources(created);
      void refreshProducts(created);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function saveConfig(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current) return;
    const fd = new FormData(e.currentTarget);
    try {
      const body: Record<string, unknown> = {
        name: (fd.get("name") as string).trim(),
        system_prompt: fd.get("system_prompt"),
        business_rules: fd.get("business_rules"),
        max_turns: parseInt(fd.get("max_turns") as string) || 15,
        product_mode: fd.get("product_mode"),
        product_api_url: (fd.get("product_api_url") as string).trim(),
        rag_enabled: fd.get("rag_enabled") === "on",
        external_products: fd.get("external_products") === "on",
        skills: fd.getAll("skills") as string[],
      };
      const pkey = (fd.get("product_api_key") as string).trim();
      if (pkey) body.product_api_key = pkey;
      await api(`${agentBase()}/config`, { method: "PUT", body: JSON.stringify(body) }, chatKey());
      await loadAgents(tid()!);
      toast("Configuração sincronizada — vale já na próxima mensagem.");
      void refreshProducts(current);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function deleteAgent() {
    if (!current) return;
    if (!confirm(`Excluir o agente "${current.name}" e todos os seus dados?`)) return;
    try {
      await api(agentBase(), { method: "DELETE" }, chatKey());
      setCurrentAgentId(null);
      setView(null);
      await loadAgents(tid()!);
      toast("Agente excluído.");
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  // ---------------- Chat ---------------- //

  async function sendChat(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("message") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !current) return;
    input.value = "";
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const r: ChatMeta = await api(
        `${agentBase()}/chat`,
        { method: "POST", body: JSON.stringify({ message: text, history: historyRef.current }) },
        chatKey(),
      );
      historyRef.current.push({ role: "user", content: text });
      historyRef.current.push({ role: "assistant", content: r.response });
      setMessages((m) => [...m, { role: "bot", text: r.response, meta: r }]);
    } catch (e2) {
      setMessages((m) => [...m, { role: "bot", text: "⚠️ " + (e2 as Error).message }]);
    }
  }

  // ---------------- Conhecimento ---------------- //

  const refreshSources = useCallback(
    async (agent: AgentPublic) => {
      try {
        const list: SourceInfo[] = await api(`/v1/tenants/${agent.tenant_id}/agents/${agent.slug}/knowledge/sources`, {}, chatKey());
        setSources(list);
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, toast],
  );

  async function uploadPdf(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const name = (fd.get("source_name") as string).trim();
    const file = fd.get("file") as File | null;
    if (!name || !file || !file.size) return toast("Informe o nome da fonte e escolha um PDF.", true);
    try {
      const r = await api(`${agentBase()}/knowledge/pdf`, { method: "POST", body: fd }, chatKey());
      toast(r.status === "queued" ? `PDF enfileirado (task ${r.task_id}).` : `PDF indexado: ${r.chunks_created} chunks.`);
      form.reset();
      void refreshSources(current);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function ingestText(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const name = (fd.get("source_name") as string).trim();
    const text = (fd.get("text") as string).trim();
    if (!name || !text) return toast("Informe o nome da fonte e o texto.", true);
    try {
      const r = await api(`${agentBase()}/knowledge/text`, { method: "POST", body: JSON.stringify({ source_name: name, text }) }, chatKey());
      toast(r.status === "queued" ? `Texto enfileirado (task ${r.task_id}).` : `Texto indexado: ${r.chunks_created} chunks.`);
      form.reset();
      void refreshSources(current);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function deleteSource(name: string) {
    if (!current) return;
    try {
      await api(`${agentBase()}/knowledge/sources/${encodeURIComponent(name)}`, { method: "DELETE" }, chatKey());
      void refreshSources(current);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  // ---------------- Produtos ---------------- //

  const refreshProducts = useCallback(
    async (agent: AgentPublic) => {
      if (agent.product_mode === "none") {
        setProducts([]);
        return;
      }
      try {
        const list: Product[] = await api(`/v1/tenants/${agent.tenant_id}/agents/${agent.slug}/products`, {}, chatKey());
        setProducts(list);
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, toast],
  );

  async function addProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    if (!(fd.get("name") as string).trim() || !fd.get("price")) return toast("Nome e preço são obrigatórios.", true);
    try {
      await api(
        `${agentBase()}/products`,
        {
          method: "POST",
          body: JSON.stringify({
            name: (fd.get("name") as string).trim(),
            description: (fd.get("description") as string).trim(),
            price: parseFloat(fd.get("price") as string),
            stock: parseInt(fd.get("stock") as string) || 0,
          }),
        },
        chatKey(),
      );
      form.reset();
      void refreshProducts(current);
      toast("Produto adicionado.");
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function saveProduct(p: Product, price: number, stock: number) {
    if (!current) return;
    try {
      await api(`${agentBase()}/products/${p.id}`, { method: "PUT", body: JSON.stringify({ price, stock }) }, chatKey());
      toast("Produto atualizado.");
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function deleteProduct(id: number) {
    if (!current) return;
    try {
      await api(`${agentBase()}/products/${id}`, { method: "DELETE" }, chatKey());
      void refreshProducts(current);
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  // ---------------- Membros ---------------- //

  const refreshMembers = useCallback(async () => {
    if (!currentTenantId) return;
    try {
      const list: Member[] = await api(`/v1/tenants/${currentTenantId}/members`);
      setMembers(list);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }, [api, toast, currentTenantId]);

  async function addMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!currentTenantId) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const email = (fd.get("email") as string).trim();
    if (!email) return toast("Informe o e-mail.", true);
    try {
      const r = await api(`/v1/tenants/${currentTenantId}/members`, {
        method: "POST",
        body: JSON.stringify({ email, role: fd.get("role") }),
      });
      setMemberCreated(r);
      form.reset();
      void refreshMembers();
      toast("Membro adicionado.");
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  async function removeMember(userId: string) {
    if (!currentTenantId) return;
    try {
      await api(`/v1/tenants/${currentTenantId}/members/${userId}`, { method: "DELETE" });
      void refreshMembers();
    } catch (e2) {
      toast((e2 as Error).message, true);
    }
  }

  function showTab(v: View) {
    setView(v);
    if (v === "members") void refreshMembers();
  }

  const showAgentTabs = current !== null && view !== null && view !== "createTenant" && view !== "createAgent";

  return (
    <>
      <header>
        <h1>Blip Agent — Painel</h1>
        <input
          type="password"
          placeholder="X-Admin-Key"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
        />
        <button className="btn small" onClick={() => connect(adminKey.trim())}>
          Conectar
        </button>
      </header>

      <div className="layout">
        <aside>
          <div className="side-head">Tenant</div>
          <div className="side-sub">
            <select value={currentTenantId ?? ""} onChange={(e) => selectTenant(e.target.value)}>
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
            <button
              className="btn secondary small"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => {
                setCurrentAgentId(null);
                setTenantCreated(null);
                setView("createTenant");
              }}
            >
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
                  onClick={() => selectAgent(a.id)}
                >
                  <div>{a.name}</div>
                  <div className="aid">{a.slug}</div>
                </div>
              ))
            )}
          </div>
          <div className="side-foot">
            <button
              className="btn secondary small"
              style={{ width: "100%" }}
              onClick={() => {
                if (!currentTenantId) return toast("Selecione um tenant primeiro.", true);
                setCurrentAgentId(null);
                setView("createAgent");
              }}
            >
              + Novo agente
            </button>
          </div>
        </aside>

        <main>
          {showAgentTabs && (
            <nav className="tabs">
              {(["chat", "config", "knowledge", "products", "members"] as const).map((t) => (
                <button key={t} className={view === t ? "active" : ""} onClick={() => showTab(t)}>
                  {t === "chat"
                    ? "Chat"
                    : t === "config"
                      ? "Configuração"
                      : t === "knowledge"
                        ? "Conhecimento"
                        : t === "products"
                          ? "Produtos"
                          : "Membros"}
                </button>
              ))}
            </nav>
          )}

          {view === "createTenant" && (
            <div className="tab-body">
              <div className="form-card">
                <h2>Novo tenant</h2>
                <p className="hint">
                  Um tenant é dono de N agentes. Criar gera a <b>chave do tenant</b> (consumo/chat) e o primeiro
                  usuário <b>owner</b>.
                </p>
                <form onSubmit={createTenant}>
                  <div className="row2">
                    <div>
                      <label>Nome *</label>
                      <input name="name" placeholder="Acme Ltda" required />
                    </div>
                    <div>
                      <label>ID (slug, opcional)</label>
                      <input name="id" placeholder="acme" />
                    </div>
                  </div>
                  <div className="row2">
                    <div>
                      <label>E-mail do owner *</label>
                      <input name="owner_email" placeholder="dono@acme.com" required />
                    </div>
                    <div>
                      <label>Nome do owner</label>
                      <input name="owner_name" placeholder="Maria" />
                    </div>
                  </div>
                  <button className="btn" type="submit">
                    Criar tenant
                  </button>
                </form>
                {tenantCreated && (
                  <div style={{ marginTop: 14, fontSize: 13 }}>
                    ✅ Tenant <b>{tenantCreated.id}</b> criado.
                    <br />
                    Chave do tenant (consumo/chat): <code className="key">{tenantCreated.api_key}</code>
                    <br />
                    Owner {tenantCreated.owner_email} — api_key: <code className="key">{tenantCreated.owner_api_key}</code>
                    <br />
                    <span className="hint">Guarde: exibidas só agora.</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {view === "createAgent" && (
            <div className="tab-body">
              <div className="form-card">
                <h2>
                  Novo agente <span className="badge">{tid()}</span>
                </h2>
                <p className="hint">
                  Ao criar, o endpoint <code>/v1/tenants/{"{tenant}"}/agents/{"{slug}"}/chat</code> passa a responder
                  imediatamente.
                </p>
                <form onSubmit={createAgent}>
                  <div className="row2">
                    <div>
                      <label>Nome *</label>
                      <input name="name" placeholder="Minha Loja" required />
                    </div>
                    <div>
                      <label>Slug (opcional)</label>
                      <input name="slug" placeholder="minha-loja" />
                    </div>
                  </div>
                  <label>System prompt (vazio = padrão compacto)</label>
                  <textarea name="system_prompt" placeholder="Você é o assistente virtual de..." />
                  <label>Regras de negócio</label>
                  <textarea name="business_rules" placeholder="Troca em até 7 dias, reembolso se atraso > 7 dias..." />
                  <div className="row2">
                    <div>
                      <label>Máx. de turnos antes do handoff</label>
                      <input name="max_turns" type="number" defaultValue={15} />
                    </div>
                    <div>
                      <label>Fonte de produtos</label>
                      <select name="product_mode" defaultValue="none">
                        <option value="none">Sem produtos</option>
                        <option value="internal">Catálogo interno (gerenciado aqui)</option>
                        <option value="external">API externa do cliente</option>
                      </select>
                    </div>
                  </div>
                  <div className="row2">
                    <div>
                      <label>URL da API de produtos (modo externo)</label>
                      <input name="product_api_url" placeholder="https://api.cliente.com/products" />
                    </div>
                    <div>
                      <label>Chave da API de produtos (opcional)</label>
                      <input name="product_api_key" />
                    </div>
                  </div>
                  <div className="row2">
                    <div className="check">
                      <input type="checkbox" name="rag_enabled" defaultChecked />
                      <label>RAG habilitado</label>
                    </div>
                    <div className="check">
                      <input type="checkbox" name="external_products" defaultChecked />
                      <label>Catálogo externo permitido</label>
                    </div>
                  </div>
                  <label>Skills</label>
                  <SkillsCheckboxes />
                  <button className="btn" type="submit">
                    Criar agente
                  </button>
                </form>
              </div>
            </div>
          )}

          {showAgentTabs && view === "chat" && current && (
            <div className="chat-tab">
              <div className="chat-messages">
                {messages.length === 0 && <div className="empty">Envie uma mensagem para testar o agente.</div>}
                {messages.map((m, i) => (
                  <div key={i} className={"msg " + m.role + (m.meta?.should_handoff ? " handoff" : "")}>
                    {m.text}
                    {m.meta && (
                      <span className="meta">
                        {`${m.meta.agent_used} · ${m.meta.intent} (${m.meta.confidence}) · ${m.meta.source} · ${m.meta.tokens_used} tokens`}
                        {m.meta.rag_chunks_used ? ` · ${m.meta.rag_chunks_used} chunks RAG` : ""}
                        {m.meta.tools_called?.length ? ` · tools: ${m.meta.tools_called.join(", ")}` : ""}
                        {m.meta.should_handoff ? " · 🔁 HANDOFF" : ""}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <input name="message" placeholder="Mensagem do cliente..." autoComplete="off" />
                <button className="btn" type="submit">
                  Enviar
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    historyRef.current = [];
                    setMessages([]);
                  }}
                >
                  Limpar
                </button>
              </form>
            </div>
          )}

          {showAgentTabs && view === "config" && current && (
            <div className="tab-body">
              <div className="form-card">
                <h2>
                  Configuração <span className="badge">POST {current.endpoint}</span>
                </h2>
                <p className="hint">
                  ID global: <code className="key">{current.id}</code>
                </p>
                <form key={current.id} onSubmit={saveConfig}>
                  <label>Nome</label>
                  <input name="name" defaultValue={current.name} />
                  <label>System prompt (vazio = padrão compacto)</label>
                  <textarea name="system_prompt" defaultValue={current.system_prompt} />
                  <label>Regras de negócio</label>
                  <textarea name="business_rules" defaultValue={current.business_rules} />
                  <div className="row2">
                    <div>
                      <label>Máx. de turnos</label>
                      <input name="max_turns" type="number" defaultValue={current.max_turns} />
                    </div>
                    <div>
                      <label>Fonte de produtos</label>
                      <select name="product_mode" defaultValue={current.product_mode}>
                        <option value="none">Sem produtos</option>
                        <option value="internal">Catálogo interno</option>
                        <option value="external">API externa</option>
                      </select>
                    </div>
                  </div>
                  <div className="row2">
                    <div>
                      <label>URL da API de produtos</label>
                      <input name="product_api_url" defaultValue={current.product_api_url} />
                    </div>
                    <div>
                      <label>Chave da API de produtos</label>
                      <input name="product_api_key" placeholder="(inalterada se vazio)" />
                    </div>
                  </div>
                  <div className="row2">
                    <div className="check">
                      <input type="checkbox" name="rag_enabled" defaultChecked={current.rag_enabled} />
                      <label>RAG habilitado</label>
                    </div>
                    <div className="check">
                      <input type="checkbox" name="external_products" defaultChecked={current.external_products} />
                      <label>Catálogo externo permitido</label>
                    </div>
                  </div>
                  <label>Skills</label>
                  <SkillsCheckboxes active={current.skills} />
                  <button className="btn" type="submit">
                    Salvar e sincronizar
                  </button>
                  <button className="btn danger" type="button" onClick={deleteAgent}>
                    Excluir agente
                  </button>
                </form>
              </div>
            </div>
          )}

          {showAgentTabs && view === "knowledge" && current && (
            <div className="tab-body">
              <div className="form-card">
                <h2>Adicionar PDF (FAQ, políticas...)</h2>
                <form onSubmit={uploadPdf}>
                  <label>Nome da fonte</label>
                  <input name="source_name" placeholder="faq-2026" />
                  <label>Arquivo PDF</label>
                  <input name="file" type="file" accept=".pdf" />
                  <button className="btn" type="submit">
                    Enviar e indexar
                  </button>
                </form>
              </div>
              <div className="form-card">
                <h2>Adicionar texto</h2>
                <form onSubmit={ingestText}>
                  <label>Nome da fonte</label>
                  <input name="source_name" placeholder="politica-trocas" />
                  <label>Conteúdo</label>
                  <textarea name="text" placeholder="Cole aqui o texto da base de conhecimento..." />
                  <button className="btn" type="submit">
                    Indexar texto
                  </button>
                </form>
              </div>
              <div className="form-card">
                <h2>Fontes indexadas</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Fonte</th>
                      <th>Chunks</th>
                      <th>Atualizado</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="empty">
                          Nenhuma fonte indexada.
                        </td>
                      </tr>
                    ) : (
                      sources.map((s) => (
                        <tr key={s.source_name}>
                          <td>{s.source_name}</td>
                          <td>{s.chunk_count}</td>
                          <td>{s.last_updated || ""}</td>
                          <td>
                            <button className="btn danger small" onClick={() => deleteSource(s.source_name)}>
                              Excluir
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {showAgentTabs && view === "products" && current && (
            <div className="tab-body">
              {current.product_mode === "internal" && (
                <div className="form-card">
                  <h2>Adicionar produto</h2>
                  <form onSubmit={addProduct}>
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
                    {current.product_mode === "external"
                      ? "API externa: " + (current.product_api_url || "(sem URL)")
                      : current.product_mode === "internal"
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
                      current.product_mode === "internal" ? (
                        <InternalProductRow key={p.id} product={p} onSave={saveProduct} onDelete={deleteProduct} />
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
          )}

          {showAgentTabs && view === "members" && current && (
            <div className="tab-body">
              <div className="form-card">
                <h2>
                  Adicionar membro <span className="badge">{tid()}</span>
                </h2>
                <p className="hint">
                  A api_key do usuário é exibida só ao convidar. <b>owner</b> gerencia agentes e membros; <b>member</b>{" "}
                  tem leitura, chat e conteúdo.
                </p>
                <form onSubmit={addMember}>
                  <div className="row2">
                    <div>
                      <label>E-mail *</label>
                      <input name="email" placeholder="pessoa@acme.com" />
                    </div>
                    <div>
                      <label>Papel</label>
                      <select name="role" defaultValue="member">
                        <option value="member">member</option>
                        <option value="owner">owner</option>
                      </select>
                    </div>
                  </div>
                  <button className="btn" type="submit">
                    Convidar
                  </button>
                </form>
                {memberCreated && (
                  <div style={{ marginTop: 12, fontSize: 13 }}>
                    ✅ {memberCreated.email} ({memberCreated.role}) — api_key:{" "}
                    <code className="key">{memberCreated.api_key}</code> <span className="hint">(exibida só agora)</span>
                  </div>
                )}
              </div>
              <div className="form-card">
                <h2>Membros do tenant</h2>
                <table>
                  <thead>
                    <tr>
                      <th>E-mail</th>
                      <th>Papel</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="empty">
                          Sem membros.
                        </td>
                      </tr>
                    ) : (
                      members.map((m) => (
                        <tr key={m.user_id}>
                          <td>{m.email}</td>
                          <td>{m.role}</td>
                          <td>
                            <button className="btn danger small" onClick={() => removeMember(m.user_id)}>
                              Remover
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>

      {toastMsg && <div className={"toast" + (toastMsg.error ? " error" : "")}>{toastMsg.msg}</div>}
    </>
  );
}

function InternalProductRow({
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

function SkillsCheckboxes({ active }: { active?: string[] }) {
  return (
    <div className="skills-grid">
      {SKILLS_LIST.map((s) => (
        <div key={s} className="check">
          <input type="checkbox" name="skills" value={s} id={`skill-${s}`} defaultChecked={active ? active.includes(s) : false} />
          <label htmlFor={`skill-${s}`}>{s}</label>
        </div>
      ))}
    </div>
  );
}
