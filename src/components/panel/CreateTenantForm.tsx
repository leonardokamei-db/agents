"use client";

import { type FormEvent } from "react";

import type { TenantCreated } from "./types";

/** Tela "Novo tenant": form + exibição única das chaves geradas. */
export function CreateTenantForm({
  onSubmit,
  created,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  created: TenantCreated | null;
}) {
  return (
    <div className="tab-body">
      <div className="form-card">
        <h2>Novo tenant</h2>
        <p className="hint">
          Um tenant é dono de N agentes. Criar gera a <b>chave do tenant</b> (consumo/chat) e o primeiro usuário{" "}
          <b>owner</b>.
        </p>
        <form onSubmit={onSubmit}>
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
        {created && (
          <div style={{ marginTop: 14, fontSize: 13 }}>
            ✅ Tenant <b>{created.id}</b> criado.
            <br />
            Chave do tenant (consumo/chat): <code className="key">{created.api_key}</code>
            <br />
            Owner {created.owner_email} — api_key: <code className="key">{created.owner_api_key}</code>
            <br />
            <span className="hint">Guarde: exibidas só agora.</span>
          </div>
        )}
      </div>
    </div>
  );
}
