/**
 * Skills: a unidade de capacidade de um agente (porta `app/skills/base.py`).
 *
 * Uma skill tem contrato único: nome + descrição + schema Zod de args + handler
 * -> SkillResult. Schema (function calling da Anthropic) e dispatch saem da MESMA
 * fonte (o REGISTRY), então nunca dessincronizam.
 *
 * Fronteira desenhada para virar remota (Lambda/HTTP): `SkillContext`/`SkillResult`
 * carregam só dados serializáveis e os args são validados por Zod. Hoje tudo é
 * `LocalSkill` (in-process).
 */

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentConfig } from "../domain";
import { getLogger } from "../logging";
import type { ChatTool } from "../llm";

const log = getLogger("blip-agent.skills");

// Categorias — derivam o conjunto default de um agente a partir das flags.
export const CATEGORY_KNOWLEDGE = "knowledge"; // depende de ragEnabled
export const CATEGORY_CATALOG = "catalog"; // depende de productMode != "none"
export const CATEGORY_SUPPORT = "support"; // sempre disponível
export const CATEGORY_GENERAL = "general"; // sempre disponível

/** Tudo que uma skill precisa para executar (só dados serializáveis). */
export interface SkillContext {
  agent: AgentConfig;
}

/** Saída tipada e JSON-serializável de uma skill. */
export class SkillResult {
  data: unknown;
  handoff: boolean;
  handoffReason: string | null;
  /** Resposta determinística pronta -> skill terminal (atalhos de 0 token). */
  directResponse: string | null;
  sources: string[];

  constructor(init: {
    data?: unknown;
    handoff?: boolean;
    handoffReason?: string | null;
    directResponse?: string | null;
    sources?: string[];
  }) {
    this.data = init.data ?? null;
    this.handoff = init.handoff ?? false;
    this.handoffReason = init.handoffReason ?? null;
    this.directResponse = init.directResponse ?? null;
    this.sources = init.sources ?? [];
  }

  /** Serializa `data` para devolver ao LLM como resultado da tool. */
  toolPayload(): string {
    try {
      return JSON.stringify(this.data ?? null);
    } catch {
      return JSON.stringify({ error: "Resultado não serializável." });
    }
  }
}

type Handler = (ctx: SkillContext, args: unknown) => Promise<SkillResult> | SkillResult;

export interface Skill {
  name: string;
  description: string;
  argsModel: z.ZodType;
  category: string;
  kind: string; // "local" hoje; "lambda"/"http" quando remota
  invoke(ctx: SkillContext, args: unknown): Promise<SkillResult> | SkillResult;
  toToolSchema(): ChatTool;
}

class LocalSkill implements Skill {
  readonly kind = "local";
  constructor(
    readonly name: string,
    readonly description: string,
    readonly argsModel: z.ZodType,
    private readonly handler: Handler,
    readonly category: string,
  ) {}

  invoke(ctx: SkillContext, args: unknown): Promise<SkillResult> | SkillResult {
    return this.handler(ctx, args);
  }

  toToolSchema(): ChatTool {
    const schema = zodToJsonSchema(this.argsModel, { target: "openApi3" }) as Record<string, unknown>;
    delete schema.$schema;
    delete schema.title;
    return {
      name: this.name,
      description: this.description,
      input_schema: schema,
    };
  }
}

// --- Registry --------------------------------------------------------------- //

export const REGISTRY = new Map<string, Skill>();

export function register(skill: Skill): Skill {
  REGISTRY.set(skill.name, skill);
  return skill;
}

/** Registra uma função como LocalSkill (mesma ergonomia do @skill do Python). */
export function registerLocal<S extends z.ZodType>(
  name: string,
  description: string,
  argsModel: S,
  handler: (ctx: SkillContext, args: z.infer<S>) => Promise<SkillResult> | SkillResult,
  category: string = CATEGORY_GENERAL,
): void {
  register(new LocalSkill(name, description, argsModel, handler as Handler, category));
}

export function getSkill(name: string): Skill | undefined {
  return REGISTRY.get(name);
}

export function allSkillNames(): string[] {
  return [...REGISTRY.keys()];
}

/** Schemas (function calling) das skills habilitadas, na ordem dada. */
export function toolSchemasFor(names: string[]): ChatTool[] {
  return names.filter((n) => REGISTRY.has(n)).map((n) => REGISTRY.get(n)!.toToolSchema());
}

/**
 * Conjunto de skills de um agente. Explícito (intersectado com o registry) ou,
 * se vazio, DERIVADO das flags (RAG -> knowledge; catálogo -> catalog; suporte/
 * gerais sempre). Mantém agentes antigos funcionando sem migração.
 */
export function enabledSkillsFor(agent: AgentConfig): string[] {
  if (agent.skills.length > 0) {
    return agent.skills.filter((n) => REGISTRY.has(n));
  }
  const names: string[] = [];
  for (const [name, sk] of REGISTRY) {
    if (sk.category === CATEGORY_KNOWLEDGE && !agent.ragEnabled) continue;
    if (sk.category === CATEGORY_CATALOG && agent.productMode === "none") continue;
    names.push(name);
  }
  return names;
}

/** Valida os args com Zod e despacha. Sempre devolve SkillResult (erro -> data.error). */
export async function invokeSkill(name: string, rawArgs: unknown, ctx: SkillContext): Promise<SkillResult> {
  // Os args podem conter PII (ex.: nome/e-mail do usuário em create_ticket), então
  // o dump completo fica em DEBUG (abaixo do threshold padrão INFO); no INFO só vai
  // o nome da skill + o agente.
  log.info(`skill: ${name} agent=${ctx.agent.id}`);
  log.debug(`skill args: ${name}(${safeArgs(rawArgs)})`);
  const sk = REGISTRY.get(name);
  if (!sk) return new SkillResult({ data: { error: `Skill desconhecida: ${name}` } });
  const parsed = sk.argsModel.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return new SkillResult({ data: { error: `Argumentos inválidos para ${name}: ${parsed.error.message}` } });
  }
  return sk.invoke(ctx, parsed.data);
}

function safeArgs(raw: unknown): string {
  try {
    return JSON.stringify(raw);
  } catch {
    return "?";
  }
}
