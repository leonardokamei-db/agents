"use client";

import { useState } from "react";

import type { ToastFn } from "./types";

interface AssistDraft {
  system_prompt: string;
  business_rules: string;
  notes: string;
  tokens_used: number;
}

/**
 * Caixa "Gerar com IA": o time de UX descreve um briefing e a IA rascunha o system
 * prompt e as regras de negócio, preenchendo os <textarea> do formulário (lidos por
 * id). É só sugestão — o formulário ainda precisa ser salvo (sanitiza ao persistir).
 */
export function AssistBox({
  tenantId,
  api,
  apiKey,
  toast,
  targetSystemId,
  targetRulesId,
  nameId,
  defaultName,
}: {
  tenantId: string | null;
  api: (path: string, opts?: RequestInit, apiKey?: string | null) => Promise<AssistDraft>;
  apiKey: string | null;
  toast: ToastFn;
  targetSystemId: string;
  targetRulesId: string;
  nameId?: string;
  defaultName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("");
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState("");

  async function generate() {
    if (!tenantId) return toast("Selecione um tenant primeiro.", true);
    if (!brief.trim()) return toast("Descreva o briefing para a IA.", true);
    setLoading(true);
    setNotes("");
    try {
      const sysEl = document.getElementById(targetSystemId) as HTMLTextAreaElement | null;
      const rulesEl = document.getElementById(targetRulesId) as HTMLTextAreaElement | null;
      const nameEl = nameId ? (document.getElementById(nameId) as HTMLInputElement | null) : null;
      const agentName = (nameEl?.value || defaultName || "").trim();
      const skills = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[name="skills"]:checked'),
      ).map((el) => el.value);
      const body: Record<string, unknown> = { brief: brief.trim(), skills };
      if (agentName) body.agent_name = agentName;
      if (tone.trim()) body.tone = tone.trim();
      if (sysEl?.value.trim()) body.current_system_prompt = sysEl.value;
      if (rulesEl?.value.trim()) body.current_business_rules = rulesEl.value;
      const r = await api(
        `/v1/tenants/${tenantId}/assist/agent-config`,
        { method: "POST", body: JSON.stringify(body) },
        apiKey,
      );
      if (sysEl && r.system_prompt) sysEl.value = r.system_prompt;
      if (rulesEl && r.business_rules) rulesEl.value = r.business_rules;
      setNotes(r.notes || "");
      toast(`Sugestão gerada (${r.tokens_used} tokens). Revise e salve.`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="assist">
      <button type="button" className="assist-toggle" onClick={() => setOpen((o) => !o)}>
        ✨ Gerar com IA {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="assist-body">
          <label>Briefing — o que o agente faz, para quem, políticas, tom...</label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Ex.: Assistente de uma loja de roupas. Tira dúvidas sobre trocas (até 7 dias), prazos de entrega e formas de pagamento. Abre chamado quando há defeito. Tom acolhedor e objetivo."
          />
          <label>Tom (opcional)</label>
          <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="cordial e objetivo" />
          <button type="button" className="btn small" onClick={generate} disabled={loading}>
            {loading ? "Gerando..." : "Gerar e preencher campos"}
          </button>
          <span className="assist-hint">A IA preenche os campos abaixo — revise antes de salvar.</span>
          {notes && (
            <div className="assist-notes">
              <b>Observações da IA:</b> {notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
