/**
 * Cliente HTTP compartilhado pelo painel admin (`/`) e pelo dashboard (`/dashboard`).
 * Mesma origem da API (sem CORS). Centraliza fetch + checagem de status + extração
 * da mensagem de erro `{detail}` — antes duplicado nas duas páginas.
 */

/** Extrai a mensagem de erro do corpo `{detail}`; cai no statusText se não-JSON. */
async function errorDetail(resp: Response): Promise<string> {
  try {
    return (await resp.json()).detail || resp.statusText;
  } catch {
    return resp.statusText; // corpo não-JSON
  }
}

/**
 * fetch + checagem de status. Em `!ok` lança `Error(detail)`; 204 devolve `null`,
 * senão o JSON parseado. `headers` extras (auth) são mesclados aos de `opts`.
 * Define `Content-Type: application/json` quando há body que não é FormData.
 */
export async function apiFetch(path: string, opts: RequestInit = {}, headers: Record<string, string> = {}) {
  const merged: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined), ...headers };
  if (opts.body && !(opts.body instanceof FormData)) merged["Content-Type"] = "application/json";
  const resp = await fetch(path, { ...opts, headers: merged });
  if (!resp.ok) throw new Error(await errorDetail(resp));
  return resp.status === 204 ? null : resp.json();
}
