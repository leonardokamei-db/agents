"use client";

import { type FormEvent } from "react";

import type { Member } from "./types";

/** Aba de membros do tenant: convite (com api_key exibida 1x) + lista. */
export function MembersTab({
  tenantId,
  members,
  created,
  onAddMember,
  onRemoveMember,
}: {
  tenantId: string | null;
  members: Member[];
  created: (Member & { api_key: string }) | null;
  onAddMember: (e: FormEvent<HTMLFormElement>) => void;
  onRemoveMember: (userId: string) => void;
}) {
  return (
    <div className="tab-body">
      <div className="form-card">
        <h2>
          Adicionar membro <span className="badge">{tenantId}</span>
        </h2>
        <p className="hint">
          A api_key do usuário é exibida só ao convidar. <b>owner</b> gerencia agentes e membros; <b>member</b> tem
          leitura, chat e conteúdo.
        </p>
        <form onSubmit={onAddMember}>
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
        {created && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            ✅ {created.email} ({created.role}) — api_key: <code className="key">{created.api_key}</code>{" "}
            <span className="hint">(exibida só agora)</span>
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
                    <button className="btn danger small" onClick={() => onRemoveMember(m.user_id)}>
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
  );
}
