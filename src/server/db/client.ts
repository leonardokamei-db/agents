/**
 * Cliente do banco: pool postgres.js + Drizzle.
 *
 * Inicialização LAZY (Proxy): a conexão só é criada no primeiro acesso a `db`,
 * nunca no import — assim `next build` (que avalia os módulos de rota) não tenta
 * conectar e não exige `DATABASE_URL` em tempo de build. Em dev, cacheia o client
 * em globalThis para sobreviver ao hot-reload sem vazar conexões.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { DATABASE_URL } from "../config";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;
type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { _blipSql?: Sql };

let _sql: Sql | null = null;
let _db: Db | null = null;

/**
 * SSL: obrigatório em provedores gerenciados (Supabase/Neon); desligado em local
 * (Docker) e na rede interna do Railway. `?sslmode=disable` na URL também desliga.
 */
function sslFor(url: string): "require" | false {
  if (/[?&]sslmode=disable/i.test(url)) return false;
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".railway.internal")) {
      return false;
    }
  } catch {
    /* URL não parseável (senha com caracteres especiais): assume remoto -> SSL */
  }
  return "require";
}

function init(): Db {
  if (_db) return _db;
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL não configurada — defina a URL do Postgres (com pgvector).",
    );
  }
  // prepare:false -> compatível com poolers (Supabase Supavisor / pgbouncer) em
  // qualquer modo (session ou transaction). max:10 conexões por instância.
  _sql =
    globalForDb._blipSql ??
    postgres(DATABASE_URL, { max: 10, prepare: false, ssl: sslFor(DATABASE_URL) });
  if (process.env.NODE_ENV !== "production") globalForDb._blipSql = _sql;
  _db = drizzle(_sql, { schema });
  return _db;
}

/** Instância Drizzle (lazy). Use em repositories: `db.select()...`. */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = init() as unknown as Record<string | symbol, unknown>;
    const value = instance[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/** Client SQL cru (postgres.js) — usado por scripts de setup (DDL, extensão). */
export function getSqlClient(): Sql {
  init();
  return _sql!;
}

/** Fecha a conexão (scripts CLI; não use em handlers HTTP de longa duração). */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
    globalForDb._blipSql = undefined;
  }
}
