/**
 * "Spotlighting": separação estrutural entre INSTRUÇÃO (confiável, do sistema) e
 * DADO (não confiável: cliente, histórico, saída de skills/RAG/catálogo).
 *
 * Envolvemos todo dado não confiável em blocos delimitados por um SENTINELA
 * aleatório, gerado uma vez por requisição. Como o atacante não consegue prever
 * o id, ele não consegue "fechar" o bloco e voltar ao contexto de instrução. O
 * system prompt (ver `prompts.ts::securityBlock`) referencia esse mesmo id e
 * instrui o modelo a tratar tudo dentro dos blocos como texto, nunca como ordem.
 *
 * Llama 3.3 respeita a hierarquia de papéis pior que modelos de fronteira, então
 * a delimitação textual + o reforço no prompt importam mais que o `role` sozinho.
 */

import { randomUUID } from "node:crypto";

/** Sentinela aleatório (hex, sem hífens) para marcar fronteiras de dado. */
export function makeSentinel(): string {
  return randomUUID().replace(/-/g, "");
}

/** Envolve a mensagem/histórico do cliente como DADO não confiável. */
export function wrapUserData(sentinel: string, text: string): string {
  return (
    `<dados_do_usuario id="${sentinel}">\n` +
    text +
    `\n</dados_do_usuario id="${sentinel}">`
  );
}

/** Envolve a saída de uma ferramenta (RAG, catálogo, etc.) como DADO não confiável. */
export function wrapToolData(sentinel: string, name: string, payload: string): string {
  return (
    `<dados_de_ferramenta nome="${name}" id="${sentinel}">\n` +
    payload +
    `\n</dados_de_ferramenta id="${sentinel}">`
  );
}
