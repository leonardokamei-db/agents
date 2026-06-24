/**
 * Logs correlacionados por requisição (porta `app/logging_ctx.py`).
 *
 * Em vez de contextvars + filtro do logging do Python, usamos `AsyncLocalStorage`:
 * o wrapper de rota (`http/route.ts`) abre um escopo com `requestId` + `tenant`, e
 * todo log emitido durante a requisição sai correlacionado, sem passar ids à mão.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { LOG_LEVEL } from "./config";

export interface LogContext {
  requestId: string;
  tenant: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Extrai o tenant de /v1/tenants/{tenant_id}/... (ou '-'). */
export function tenantFromPath(path: string): string {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "tenants") {
    return parts[2];
  }
  return "-";
}

const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const threshold = LEVELS[LOG_LEVEL] ?? 20;

function fmt(extra: unknown[]): string {
  if (extra.length === 0) return "";
  return (
    " " +
    extra
      .map((v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()))
      .join(" ")
  );
}

function emit(levelName: "DEBUG" | "INFO" | "WARNING" | "ERROR", name: string, msg: string, extra: unknown[]): void {
  if ((LEVELS[levelName] ?? 20) < threshold) return;
  const ctx = storage.getStore();
  const req = ctx?.requestId ?? "-";
  const tenant = ctx?.tenant ?? "-";
  const line = `${new Date().toISOString()}  ${levelName}  [req=${req} tenant=${tenant}] ${name}  ${msg}${fmt(extra)}`;
  if (levelName === "ERROR") console.error(line);
  else if (levelName === "WARNING") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
  /** Erro + stack (espelha logging.exception do Python). */
  exception(msg: string, err: unknown): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (msg, ...extra) => emit("DEBUG", name, msg, extra),
    info: (msg, ...extra) => emit("INFO", name, msg, extra),
    warn: (msg, ...extra) => emit("WARNING", name, msg, extra),
    error: (msg, ...extra) => emit("ERROR", name, msg, extra),
    exception: (msg, err) => {
      const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      emit("ERROR", name, `${msg} ${detail}`, []);
    },
  };
}
