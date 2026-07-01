"use client";

import { type FormEvent } from "react";

import { AssistBox } from "./AssistBox";
import { SkillsCheckboxes } from "./SkillsCheckboxes";
import type { ApiFn, SkillCatalogItem, ToastFn } from "./types";

/** Tela "Novo agente": criar já abre o endpoint de chat (sem redeploy). */
export function CreateAgentForm({
  tenantId,
  api,
  apiKey,
  toast,
  skillCatalog,
  onSubmit,
}: {
  tenantId: string | null;
  api: ApiFn;
  apiKey: string | null;
  toast: ToastFn;
  skillCatalog: SkillCatalogItem[];
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="tab-body">
      <div className="form-card">
        <h2>
          Novo agente <span className="badge">{tenantId}</span>
        </h2>
        <p className="hint">
          Ao criar, o endpoint <code>/v1/tenants/{"{tenant}"}/agents/{"{slug}"}/chat</code> passa a responder
          imediatamente.
        </p>
        <form onSubmit={onSubmit}>
          <div className="row2">
            <div>
              <label>Nome *</label>
              <input id="new_name" name="name" placeholder="Minha Loja" required />
            </div>
            <div>
              <label>Slug (opcional)</label>
              <input name="slug" placeholder="minha-loja" />
            </div>
          </div>
          <AssistBox
            tenantId={tenantId}
            api={api}
            apiKey={apiKey}
            toast={toast}
            nameId="new_name"
            targetSystemId="new_system_prompt"
            targetRulesId="new_business_rules"
          />
          <label>System prompt (vazio = padrão compacto)</label>
          <textarea id="new_system_prompt" name="system_prompt" placeholder="Você é o assistente virtual de..." />
          <label>Regras de negócio</label>
          <textarea
            id="new_business_rules"
            name="business_rules"
            placeholder="Troca em até 7 dias, reembolso se atraso > 7 dias..."
          />
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
          <SkillsCheckboxes catalog={skillCatalog} />
          <button className="btn" type="submit">
            Criar agente
          </button>
        </form>
      </div>
    </div>
  );
}
