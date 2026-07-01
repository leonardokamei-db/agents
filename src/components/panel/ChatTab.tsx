"use client";

import { type FormEvent } from "react";

import type { ChatMsg } from "./types";

/** Aba de chat de teste do agente. */
export function ChatTab({
  messages,
  onSend,
  onClear,
}: {
  messages: ChatMsg[];
  onSend: (e: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
}) {
  return (
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
      <form className="chat-form" onSubmit={onSend}>
        <input name="message" placeholder="Mensagem do cliente..." autoComplete="off" />
        <button className="btn" type="submit">
          Enviar
        </button>
        <button className="btn secondary" type="button" onClick={onClear}>
          Limpar
        </button>
      </form>
    </div>
  );
}
