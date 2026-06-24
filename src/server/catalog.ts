/**
 * Catálogo de produtos (porta `app/catalog.py`) com duas fontes por agente:
 *   - product_mode "internal": tabela products (ProductRepository).
 *   - product_mode "external": API REST do cliente (GET product_api_url, com
 *     Authorization: Bearer opcional). Reserva não é suportada externamente.
 *
 * As funções públicas devolvem dados JSON-ready (tools do LLM + endpoints). O
 * modelo NUNCA inventa preço/estoque: tudo vem daqui.
 */

import type { AgentConfig, ProductRow } from "./domain";
import { productRowFromExternal } from "./domain";
import { getLogger } from "./logging";
import { RESERVE_EXTERNAL_UNAVAILABLE } from "./messages";
import { ProductRepository, StockError } from "./repositories/products";
import type { ProductCreateInput } from "./schemas";
import { wordSet } from "./textutil";

const log = getLogger("blip-agent.catalog");

const EXTERNAL_TIMEOUT_MS = 10_000;
const STOPWORDS = new Set(["de", "do", "da", "para", "com", "os", "as", "um", "uma"]);

const repo = new ProductRepository();

// --- API pública (tools + endpoints) — dados JSON-ready ---------------------- //

export async function listProducts(agent: AgentConfig): Promise<ProductRow[]> {
  return fetchAll(agent);
}

export async function searchProducts(agent: AgentConfig, query: string): Promise<ProductRow[]> {
  const q = query.toLowerCase();
  const products = await fetchAll(agent);
  let hits = products.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  if (hits.length === 0) hits = wordOverlapMatches(products, query);
  return hits;
}

export async function checkStock(
  agent: AgentConfig,
  productName: string,
  quantity: number,
): Promise<Record<string, unknown>> {
  const product = await findProduct(agent, productName);
  if (product === null) {
    return { product: productName, found: false, error: "Produto não encontrado no catálogo." };
  }
  return {
    product: product.name,
    found: true,
    requested: quantity,
    available: product.stock,
    can_fulfill: quantity > 0 && quantity <= product.stock,
    price_unit: round2(product.price),
    price_total: round2(product.price * quantity),
    unit: product.unit,
  };
}

export async function catalogHealth(agent: AgentConfig): Promise<Record<string, unknown>> {
  const mode = agent.productMode;
  if (mode === "none") {
    return { mode: "none", configured: false, message: "Catálogo não configurado para este agente." };
  }
  if (mode === "internal") {
    const items = await repo.listForAgent(agent.id);
    return { mode: "internal", configured: true, reachable: true, product_count: items.length };
  }
  // external
  if (!agent.externalProducts) {
    return {
      mode: "external",
      configured: Boolean(agent.productApiUrl),
      enabled: false,
      reachable: false,
      message: "Catálogo externo desligado por feature flag.",
    };
  }
  if (!agent.productApiUrl) {
    return {
      mode: "external",
      configured: false,
      enabled: true,
      reachable: false,
      message: "URL do catálogo externo não configurada.",
    };
  }
  const [reachable, count, detail] = await probeExternal(agent);
  return { mode: "external", configured: true, enabled: true, reachable, product_count: count, detail };
}

export async function reserveStock(
  agent: AgentConfig,
  productName: string,
  quantity: number,
): Promise<Record<string, unknown>> {
  if (agent.productMode !== "internal") {
    return { success: false, product: productName, error: RESERVE_EXTERNAL_UNAVAILABLE };
  }
  const product = await findProduct(agent, productName);
  if (product === null) {
    return { success: false, product: productName, error: "Produto não encontrado." };
  }
  if (quantity <= 0) {
    return { success: false, product: product.name, error: "Quantidade inválida." };
  }
  let updated: ProductRow;
  try {
    updated = await repo.decrementStock(agent.id, product.id, quantity);
  } catch (e) {
    if (e instanceof StockError) return { success: false, product: product.name, error: e.message };
    throw e;
  }
  log.info(`Reservado ${quantity} x ${updated.name} (agent=${agent.id}) — novo estoque ${updated.stock}`);
  return {
    success: true,
    product: updated.name,
    new_stock: updated.stock,
    total_charged: round2(product.price * quantity),
  };
}

// --- CRUD interno (endpoints de produtos) ----------------------------------- //

export async function createProduct(agentId: string, data: ProductCreateInput): Promise<ProductRow> {
  return repo.create(agentId, data);
}

export async function updateProduct(
  agentId: string,
  productId: number,
  changes: Partial<ProductCreateInput>,
): Promise<ProductRow | null> {
  return repo.update(agentId, productId, changes);
}

export async function deleteProduct(agentId: string, productId: number): Promise<boolean> {
  return repo.delete(agentId, productId);
}

// --- Internos --------------------------------------------------------------- //

async function fetchAll(agent: AgentConfig): Promise<ProductRow[]> {
  if (agent.productMode === "external") {
    if (!agent.externalProducts) {
      log.warn(`Catálogo externo desligado por flag (agent=${agent.id}).`);
      return [];
    }
    return fetchExternal(agent);
  }
  if (agent.productMode === "internal") return repo.listForAgent(agent.id);
  return [];
}

function externalHeaders(agent: AgentConfig): HeadersInit {
  return agent.productApiKey ? { Authorization: `Bearer ${agent.productApiKey}` } : {};
}

async function externalGet(agent: AgentConfig): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const resp = await fetch(agent.productApiUrl, { headers: externalHeaders(agent), signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).products)) {
    return (payload as Record<string, unknown>).products as unknown[];
  }
  return [];
}

async function fetchExternal(agent: AgentConfig): Promise<ProductRow[]> {
  if (!agent.productApiUrl) return [];
  let payload: unknown;
  try {
    payload = await externalGet(agent);
  } catch (e) {
    log.warn(`API externa de produtos falhou (agent=${agent.id}):`, String(e));
    return [];
  }
  return extractItems(payload)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && Boolean((p as Record<string, unknown>).name))
    .map((p, i) => productRowFromExternal(p, i));
}

async function probeExternal(agent: AgentConfig): Promise<[boolean, number, string]> {
  let payload: unknown;
  try {
    payload = await externalGet(agent);
  } catch (e) {
    return [false, 0, `Falha ao acessar o catálogo externo: ${String(e)}`];
  }
  return [true, extractItems(payload).length, "OK"];
}

/** Resolve um produto pelo nome: exato -> substring -> sobreposição de palavras. */
async function findProduct(agent: AgentConfig, productName: string): Promise<ProductRow | null> {
  const products = await fetchAll(agent);
  const target = productName.toLowerCase();

  for (const p of products) {
    if (p.name.toLowerCase() === target) return p;
  }
  const substr = products.filter((p) => p.name.toLowerCase().includes(target));
  if (substr.length > 0) {
    return substr.reduce((best, p) => (p.name.length < best.name.length ? p : best));
  }
  const matches = wordOverlapMatches(products, productName);
  return matches[0] ?? null;
}

/** Produtos ordenados por sobreposição de palavras com a query (prefixo conta). */
function wordOverlapMatches(products: ProductRow[], query: string): ProductRow[] {
  const queryWords = [...wordSet(query)].filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (queryWords.length === 0) return [];
  const scored: Array<[number, ProductRow]> = [];
  for (const p of products) {
    const hayWords = [...wordSet(`${p.name} ${p.description}`)].filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const score = queryWords.reduce(
      (acc, qw) => acc + (hayWords.some((hw) => hw.startsWith(qw) || qw.startsWith(hw)) ? 1 : 0),
      0,
    );
    if (score > 0) scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map(([, p]) => p);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
