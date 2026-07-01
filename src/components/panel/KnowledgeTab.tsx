"use client";

import { type FormEvent } from "react";

import type { SourceInfo } from "./types";

/** Aba de conhecimento (RAG): upload de PDF/texto + fontes indexadas. */
export function KnowledgeTab({
  sources,
  onUploadPdf,
  onIngestText,
  onDeleteSource,
}: {
  sources: SourceInfo[];
  onUploadPdf: (e: FormEvent<HTMLFormElement>) => void;
  onIngestText: (e: FormEvent<HTMLFormElement>) => void;
  onDeleteSource: (name: string) => void;
}) {
  return (
    <div className="tab-body">
      <div className="form-card">
        <h2>Adicionar PDF (FAQ, políticas...)</h2>
        <form onSubmit={onUploadPdf}>
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
        <form onSubmit={onIngestText}>
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
                    <button className="btn danger small" onClick={() => onDeleteSource(s.source_name)}>
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
  );
}
