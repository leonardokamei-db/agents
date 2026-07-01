"use client";

import { type FormEvent } from "react";

import { AssistBox } from "./AssistBox";
import { SkillsCheckboxes } from "./SkillsCheckboxes";
import type { AgentPublic, ApiFn, SkillCatalogItem, ToastFn } from "./types";

/** Aba de configuração do agente: edição de prompt/regras/flags/skills + exclusão. */
export function ConfigForm({
  agent,
  tenantId,
  api,
  apiKey,
  toast,
  skillCatalog,
  onSubmit,
  onDelete,
}: {
  agent: AgentPublic;
  tenantId: string | null;
  api: ApiFn;
  apiKey: string | null;
  toast: ToastFn;
  skillCatalog: SkillCatalogItem[];
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="tab-body">
      <div className="form-card">
        <h2>
          Configuração <span className="badge">POST {agent.endpoint}</span>
        </h2>
        <p className="hint">
          ID global: <code className="key">{agent.id}</code>
        </p>
        {/* key força remount (reset dos defaultValue) ao trocar de agente. */}
        <form key={agent.id} onSubmit={onSubmit}>
          <label>Nome</label>
          <input id="cfg_name" name="name" defaultValue={agent.name} />
          <AssistBox
            tenantId={tenantId}
            api={api}
            apiKey={apiKey}
            toast={toast}
            nameId="cfg_name"
            targetSystemId="cfg_system_prompt"
            targetRulesId="cfg_business_rules"
            defaultName={agent.name}
          />
          <label>System prompt (vazio = padrão compacto)</label>
          <textarea id="cfg_system_prompt" name="system_prompt" defaultValue={agent.system_prompt} />
          <label>Regras de negócio</label>
          <textarea id="cfg_business_rules" name="business_rules" defaultValue={agent.business_rules} />
          <div className="row2">
            <div>
              <label>Máx. de turnos</label>
              <input name="max_turns" type="number" defaultValue={agent.max_turns} />
            </div>
            <div>
              <label>Fonte de produtos</label>
              <select name="product_mode" defaultValue={agent.product_mode}>
                <option value="none">Sem produtos</option>
                <option value="internal">Catálogo interno</option>
                <option value="external">API externa</option>
              </select>
            </div>
          </div>
          <div className="row2">
            <div>
              <label>URL da API de produtos</label>
              <input name="product_api_url" defaultValue={agent.product_api_url} />
            </div>
            <div>
              <label>Chave da API de produtos</label>
              <input name="product_api_key" placeholder="(inalterada se vazio)" />
            </div>
          </div>
          <div className="row2">
            <div className="check">
              <input type="checkbox" name="rag_enabled" defaultChecked={agent.rag_enabled} />
              <label>RAG habilitado</label>
            </div>
            <div className="check">
              <input type="checkbox" name="external_products" defaultChecked={agent.external_products} />
              <label>Catálogo externo permitido</label>
            </div>
          </div>
          <label>Skills</label>
          <SkillsCheckboxes active={agent.skills} catalog={skillCatalog} />
          <button className="btn" type="submit">
            Salvar e sincronizar
          </button>
          <button className="btn danger" type="button" onClick={onDelete}>
            Excluir agente
          </button>
        </form>
      </div>
    </div>
  );
}
