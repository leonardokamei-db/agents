/**
 * Carregador mínimo de `.env` para os scripts CLI (tsx) — sem dependência externa.
 * Importe-o ANTES de qualquer módulo que leia process.env (ex.: config).
 *
 * No deploy (Railway) não há arquivo `.env` e as variáveis vêm injetadas: este
 * loader então é no-op e usa o ambiente real. Variáveis já definidas não são
 * sobrescritas.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), ".env");
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
