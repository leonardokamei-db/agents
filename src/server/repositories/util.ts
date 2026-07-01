/**
 * Utilitários compartilhados pelos repositórios (acesso a dados).
 */

/**
 * Normaliza um valor de data vindo do driver para ISO-8601 (ou "" se ausente).
 * O postgres.js pode devolver `Date` ou `string` conforme a coluna/parse; agregados
 * como `max(created_at)` podem ainda vir tipados como `unknown`. Aceita qualquer
 * entrada para cobrir esses casos sem espalhar a mesma checagem por vários repos.
 */
export function toIso(d: unknown): string {
  if (d == null) return "";
  return d instanceof Date ? d.toISOString() : String(d);
}
