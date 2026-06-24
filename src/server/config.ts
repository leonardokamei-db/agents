/**
 * Configuração central: variáveis de ambiente e constantes globais.
 *
 * Porta `app/config.py`. Mudanças do stack TS:
 *   - `DATABASE_URL` (Postgres) substitui `DB_DIR`/paths SQLite.
 *   - `REDIS_URL`/`CELERY_ENABLED` foram REMOVIDOS: a ingestão é síncrona.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? fallback : n;
}

// --- LLM (Groq) ------------------------------------------------------------ //
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
export const LLM_MAX_TOKENS = envInt("LLM_MAX_TOKENS", 512);
export const LLM_TEMPERATURE = envFloat("LLM_TEMPERATURE", 0.7);

// Economia de tokens: só as N últimas mensagens do histórico vão ao Groq.
export const HISTORY_LIMIT = envInt("HISTORY_LIMIT", 5);

// --- Embeddings (Jina) ------------------------------------------------------ //
export const JINA_API_KEY = process.env.JINA_API_KEY ?? "";
export const JINA_MODEL = process.env.JINA_MODEL ?? "jina-embeddings-v3";
export const EMBEDDING_DIM = 384;

// --- RAG -------------------------------------------------------------------- //
export const RAG_TOP_K = envInt("RAG_TOP_K", 3); // menos chunks == menos tokens
export const RAG_CHUNK_SIZE = 500; // ~tokens por chunk (proxy chars/4)
export const RAG_CHUNK_OVERLAP = 50;

// --- Banco (Postgres + pgvector) -------------------------------------------- //
// Um único engine guarda o relacional (tenants/agents/products) e os vetores RAG.
export const DATABASE_URL = process.env.DATABASE_URL ?? "";

// --- Administração ---------------------------------------------------------- //
// Chave de plataforma: cria/lista/exclui TENANTS e é superusuário em qualquer
// tenant. Defina ADMIN_API_KEY em produção (o default é só para dev).
export const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "admin-dev-key";

// Cria um tenant "default" + agente "demo" no primeiro boot com banco vazio.
export const SEED_DEMO = (process.env.SEED_DEMO ?? "1") === "1";

// Tenant padrão (criado no bootstrap).
export const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? "default";

// --- Observabilidade -------------------------------------------------------- //
export const LOG_LEVEL = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
