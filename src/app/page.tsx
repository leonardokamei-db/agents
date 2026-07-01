"use client";

/**
 * Painel admin (porta `client.html` para React). Mesma origem da API (sem CORS).
 * A X-Admin-Key autentica rotas de plataforma e, como X-API-Key, também as de
 * tenant (admin = superusuário).
 *
 * Este componente é o ORQUESTRADOR: detém o estado e os handlers; cada aba/tela
 * é um componente em `@/components/panel/*` que recebe dados e callbacks por props.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ChatTab } from "@/components/panel/ChatTab";
import { ConfigForm } from "@/components/panel/ConfigForm";
import { CreateAgentForm } from "@/components/panel/CreateAgentForm";
import { CreateTenantForm } from "@/components/panel/CreateTenantForm";
import { KnowledgeTab } from "@/components/panel/KnowledgeTab";
import { MembersTab } from "@/components/panel/MembersTab";
import { ProductsTab } from "@/components/panel/ProductsTab";
import { Sidebar } from "@/components/panel/Sidebar";
import type {
  AgentPublic,
  ChatMeta,
  ChatMsg,
  Member,
  Product,
  SkillCatalogItem,
  SourceInfo,
  TenantCreated,
  TenantPublic,
  View,
} from "@/components/panel/types";
import { apiFetch } from "@/lib/api";

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
  const [memberCreated, setMemberCreated] = useState<(Member & { api_key: string }) | null>(null);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);

  const current = agents.find((a) => a.id === currentAgentId) ?? null;

  const toast = useCallback((msg: string, error = false) => {
    setToastMsg({ msg, error });
    setTimeout(() => setToastMsg(null), 4500);
  }, []);

  const api = useCallback(
    (path: string, opts: RequestInit = {}, apiKey?: string | null) =>
      apiFetch(path, opts, { "X-Admin-Key": adminKeyRef.current, "X-API-Key": apiKey || adminKeyRef.current }),
    [],
  );

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

  // Catálogo de skills (descrições) — global; busca uma vez via qualquer tenant.
  const loadSkillCatalog = useCallback(
    async (tenantId: string) => {
      try {
        const list: SkillCatalogItem[] = await api(`/v1/tenants/${tenantId}/skills`);
        setSkillCatalog(list);
      } catch {
        /* sem catálogo: a UI cai no fallback só-nomes */
      }
    },
    [api],
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
        if (ts.length) {
          await selectTenant(ts[0].id);
          void loadSkillCatalog(ts[0].id);
        }
      } catch (e) {
        toast("Falha ao conectar: " + (e as Error).message, true);
      }
    },
    [api, toast, selectTenant, loadSkillCatalog],
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
        const list: SourceInfo[] = await api(
          `/v1/tenants/${agent.tenant_id}/agents/${agent.slug}/knowledge/sources`,
          {},
          chatKey(),
        );
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
      const r = await api(
        `${agentBase()}/knowledge/text`,
        { method: "POST", body: JSON.stringify({ source_name: name, text }) },
        chatKey(),
      );
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
        const list: Product[] = await api(
          `/v1/tenants/${agent.tenant_id}/agents/${agent.slug}/products`,
          {},
          chatKey(),
        );
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
        <a className="btn small secondary" href="/dashboard" style={{ textDecoration: "none" }}>
          📊 Dashboard
        </a>
      </header>

      <div className="layout">
        <Sidebar
          tenants={tenants}
          currentTenantId={currentTenantId}
          onSelectTenant={selectTenant}
          onNewTenant={() => {
            setCurrentAgentId(null);
            setTenantCreated(null);
            setView("createTenant");
          }}
          agents={agents}
          current={current}
          onSelectAgent={selectAgent}
          onNewAgent={() => {
            if (!currentTenantId) return toast("Selecione um tenant primeiro.", true);
            setCurrentAgentId(null);
            setView("createAgent");
          }}
        />

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

          {view === "createTenant" && <CreateTenantForm onSubmit={createTenant} created={tenantCreated} />}

          {view === "createAgent" && (
            <CreateAgentForm
              tenantId={tid()}
              api={api}
              apiKey={chatKey()}
              toast={toast}
              skillCatalog={skillCatalog}
              onSubmit={createAgent}
            />
          )}

          {showAgentTabs && view === "chat" && current && (
            <ChatTab
              messages={messages}
              onSend={sendChat}
              onClear={() => {
                historyRef.current = [];
                setMessages([]);
              }}
            />
          )}

          {showAgentTabs && view === "config" && current && (
            <ConfigForm
              agent={current}
              tenantId={tid()}
              api={api}
              apiKey={chatKey()}
              toast={toast}
              skillCatalog={skillCatalog}
              onSubmit={saveConfig}
              onDelete={deleteAgent}
            />
          )}

          {showAgentTabs && view === "knowledge" && current && (
            <KnowledgeTab
              sources={sources}
              onUploadPdf={uploadPdf}
              onIngestText={ingestText}
              onDeleteSource={deleteSource}
            />
          )}

          {showAgentTabs && view === "products" && current && (
            <ProductsTab
              agent={current}
              products={products}
              onAddProduct={addProduct}
              onSaveProduct={saveProduct}
              onDeleteProduct={deleteProduct}
            />
          )}

          {showAgentTabs && view === "members" && current && (
            <MembersTab
              tenantId={tid()}
              members={members}
              created={memberCreated}
              onAddMember={addMember}
              onRemoveMember={removeMember}
            />
          )}
        </main>
      </div>

      {toastMsg && <div className={"toast" + (toastMsg.error ? " error" : "")}>{toastMsg.msg}</div>}
    </>
  );
}
