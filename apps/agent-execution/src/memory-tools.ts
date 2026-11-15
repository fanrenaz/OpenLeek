import type { AgentMemoryBinding, MemoryToolProfile } from "./types";
import { randomUUID } from "node:crypto";

export type MemoryDynamicTool = "retain" | "recall" | "reflect" | "get_strategy" | "update_strategy" | "clear_strategy";

export interface MemoryToolPort {
  call(binding: AgentMemoryBinding, tool: MemoryDynamicTool, argumentsValue: unknown, callId?: string): Promise<unknown>;
  fork?(source: AgentMemoryBinding, target: AgentMemoryBinding, throughRound: number): Promise<void>;
}

export class HttpHindsightMemoryClient implements MemoryToolPort {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: { baseUrl: string; fetch?: typeof globalThis.fetch }) {
    this.baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol)) throw new Error("OPENLEEK_HINDSIGHT_URL must use http(s)");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async call(binding: AgentMemoryBinding, tool: MemoryDynamicTool, argumentsValue: unknown, callId?: string): Promise<unknown> {
    const args = record(argumentsValue);
    if (tool === "retain") {
      const content = requiredString(args.content, "content", 100_000);
      const context = optionalString(args.context, "context", 20_000);
      return this.request(binding, "memories", {
        items: [{
          content,
          ...(callId ? {
            document_id: `round-${String(binding.roundId).padStart(6, "0")}-${safeId(callId)}`,
            update_mode: "replace",
          } : {}),
          ...(context ? { context } : {}),
        }],
      });
    }
    if (tool === "get_strategy") return this.getStrategy(binding);
    if (tool === "update_strategy") {
      const content = requiredString(args.content, "content", 100_000);
      const context = optionalString(args.context, "context", 20_000);
      await this.requestToBank(strategyBankId(binding.bankId), "memories", {
        items: [{
          content,
          document_id: strategyEventId(binding.roundId, "update", callId),
          update_mode: "replace",
          ...(context ? { context } : {}),
        }],
      });
      return { content, ...(context ? { context } : {}) };
    }
    if (tool === "clear_strategy") {
      await this.requestToBank(strategyBankId(binding.bankId), "memories", {
        items: [{
          content: "The current strategy was cleared.",
          document_id: strategyEventId(binding.roundId, "clear", callId),
          update_mode: "replace",
        }],
      });
      return null;
    }
    const query = requiredString(args.query, "query", 20_000);
    const budget = budgetValue(args.budget);
    if (tool === "reflect") {
      const context = optionalString(args.context, "context", 20_000);
      return this.request(binding, "reflect", {
        query: context ? `${query}\n\nAdditional context:\n${context}` : query,
        budget,
      });
    }
    const response = await this.request(binding, "memories/recall", { query, budget });
    return normalizeRecallResponse(response, positiveInteger(args.maxTokens, "maxTokens", 64, 16_384, 2_000));
  }

  async fork(source: AgentMemoryBinding, target: AgentMemoryBinding, throughRound: number): Promise<void> {
    await this.copyDocuments(source.bankId, target.bankId, throughRound);
    await this.copyDocuments(strategyBankId(source.bankId), strategyBankId(target.bankId), throughRound);
  }

  private async copyDocuments(sourceBankId: string, targetBankId: string, throughRound: number): Promise<void> {
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.getFromBank(sourceBankId, `documents?limit=500&offset=${offset}`) as { items?: unknown[]; total?: number };
      const pageIds = (page.items ?? []).flatMap((item) => {
        const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const id = typeof value.id === "string" ? value.id : typeof value.document_id === "string" ? value.document_id : undefined;
        const round = id ? /^round-(\d{6})-/.exec(id) : undefined;
        return id && round && Number(round[1]) <= throughRound ? [id] : [];
      });
      ids.push(...pageIds);
      offset += page.items?.length ?? 0;
      if (!page.items?.length || offset >= (page.total ?? offset)) break;
    }
    if (!ids.length) return;
    const exportUrl = this.bankUrl(sourceBankId, "document-transfer");
    for (const id of ids) exportUrl.searchParams.append("document_id", id);
    const archive = await this.fetcher(exportUrl, { signal: AbortSignal.timeout(120_000) });
    if (!archive.ok) throw new Error(`Hindsight document export returned ${archive.status}`);
    const form = new FormData();
    form.append("file", new Blob([await archive.arrayBuffer()], { type: "application/zip" }), "memory.zip");
    const importUrl = this.bankUrl(targetBankId, "document-transfer");
    importUrl.searchParams.set("on_conflict", "skip");
    const imported = await this.fetcher(importUrl, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    const payload = await imported.json().catch(() => undefined) as { operation_id?: unknown } | undefined;
    if (!imported.ok || typeof payload?.operation_id !== "string") throw new Error(`Hindsight document import returned ${imported.status}`);
    await this.waitForOperation(targetBankId, payload.operation_id);
  }

  private async request(binding: AgentMemoryBinding, suffix: string, body: unknown): Promise<unknown> {
    return this.requestToBank(binding.bankId, suffix, body);
  }

  private async requestToBank(bankId: string, suffix: string, body: unknown): Promise<unknown> {
    const url = this.bankUrl(bankId, suffix);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`Hindsight ${suffix} returned ${response.status}`);
    return payload ?? { ok: true };
  }

  private async getFromBank(bankId: string, suffix: string): Promise<unknown> {
    const response = await this.fetcher(this.bankUrl(bankId, suffix), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`Hindsight ${suffix} returned ${response.status}`);
    return payload;
  }

  private bankUrl(bankId: string, suffix: string) {
    return new URL(`/v1/default/banks/${encodeURIComponent(bankId)}/${suffix}`, this.baseUrl);
  }

  private async waitForOperation(bankId: string, operationId: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const value = await this.getFromBank(bankId, `operations/${encodeURIComponent(operationId)}`) as { status?: unknown };
      if (value.status === "completed") return;
      if (value.status === "failed") throw new Error("Hindsight document import failed");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Hindsight document import timed out");
  }

  private async getStrategy(binding: AgentMemoryBinding): Promise<{ content: string; context?: string } | null> {
    const bankId = strategyBankId(binding.bankId);
    const events: StrategyEvent[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.getFromBank(bankId, `documents?limit=500&offset=${offset}`) as { items?: unknown[]; total?: number };
      for (const item of page.items ?? []) {
        const event = strategyEvent(item);
        if (event && event.roundId <= binding.roundId) events.push(event);
      }
      offset += page.items?.length ?? 0;
      if (!page.items?.length || offset >= (page.total ?? offset)) break;
    }
    const latest = events.sort(compareStrategyEvents).at(-1);
    if (!latest || latest.action === "clear") return null;
    const document = await this.getFromBank(bankId, `documents/${encodeURIComponent(latest.id)}`) as Record<string, unknown>;
    const content = requiredString(document.original_text, "content", 100_000);
    const retainParams = recordOrEmpty(document.retain_params);
    const context = optionalString(retainParams.context, "context", 20_000);
    return { content, ...(context ? { context } : {}) };
  }
}

export const memoryDynamicTools = [{
  type: "namespace",
  name: "memory",
  description: "Private continuity across Turns, including an optional active strategy for a self-chosen course of action.",
  tools: [
    {
      type: "function",
      name: "retain",
      description: "Store content in private memory.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["content"],
        properties: {
          content: { type: "string", minLength: 1, maxLength: 100_000 },
          context: { type: "string", maxLength: 20_000 },
        },
      },
    },
    {
      type: "function",
      name: "recall",
      description: "Retrieve relevant records from private memory.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 20_000 },
          budget: { type: "string", enum: ["low", "mid", "high"] },
          maxTokens: { type: "integer", minimum: 64, maximum: 16_384 },
        },
      },
    },
    {
      type: "function",
      name: "reflect",
      description: "Synthesize an answer from private memory.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 20_000 },
          context: { type: "string", maxLength: 20_000 },
          budget: { type: "string", enum: ["low", "mid", "high"] },
        },
      },
    },
    {
      type: "function",
      name: "get_strategy",
      description: "Retrieve the active multi-Turn strategy when previous intentions may be relevant to the current choice. Returns content and optional context, or null when none is active.",
      inputSchema: {
        type: "object", additionalProperties: false, properties: {},
      },
    },
    {
      type: "function",
      name: "update_strategy",
      description: "Create or revise the active strategy when you choose a course of action intended to guide multiple future Turns.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["content"],
        properties: {
          content: {
            type: "string",
            minLength: 1,
            maxLength: 100_000,
            description: "The active course of action intended to guide choices across multiple future Turns, not a journal or current-state summary.",
          },
          context: {
            type: "string",
            maxLength: 20_000,
            description: "Optional assumptions or conditions under which the strategy matters or should be reconsidered.",
          },
        },
      },
    },
    {
      type: "function",
      name: "clear_strategy",
      description: "Clear the active multi-Turn strategy when you no longer intend to pursue it.",
      inputSchema: {
        type: "object", additionalProperties: false, properties: {},
      },
    },
  ],
}] as const;

const experienceTools = memoryDynamicTools[0].tools.slice(0, 3);

export const splitMemoryDynamicTools = [
  {
    type: "namespace",
    name: "memory",
    description: "Private continuity for retaining, retrieving, and synthesizing past experience.",
    tools: experienceTools,
  },
  {
    type: "namespace",
    name: "strategy",
    description: "An optional active course of action intended to guide choices across multiple future Turns.",
    tools: [
      {
        type: "function",
        name: "get",
        description: "Retrieve the active multi-Turn strategy. Returns content and optional context, or null when none is active.",
        inputSchema: {
          type: "object", additionalProperties: false, properties: {},
        },
      },
      {
        type: "function",
        name: "update",
        description: "Create, revise, or clear the active multi-Turn strategy. Set content to null to clear it.",
        inputSchema: {
          type: "object", additionalProperties: false, required: ["content"],
          properties: {
            content: {
              anyOf: [
                { type: "string", minLength: 1, maxLength: 100_000 },
                { type: "null" },
              ],
              description: "The active course of action intended to guide choices across multiple future Turns, or null to clear it.",
            },
            context: {
              type: "string",
              maxLength: 20_000,
              description: "Optional assumptions or conditions under which a non-null strategy matters or should be reconsidered.",
            },
          },
        },
      },
    ],
  },
] as const;

export const hookMemoryDynamicTools = [
  {
    type: "namespace",
    name: "memory",
    description: "Private continuity for retaining and deliberately retrieving past experience.",
    tools: experienceTools.slice(0, 2),
  },
  {
    type: "namespace",
    name: "strategy",
    description: "An optional active course of action intended to guide choices across multiple future Turns.",
    tools: [splitMemoryDynamicTools[1].tools[1]],
  },
] as const;

export function dynamicToolsForMemoryProfile(profile: MemoryToolProfile) {
  if (profile === "hook-v1") return hookMemoryDynamicTools;
  return profile === "split-v2" ? splitMemoryDynamicTools : memoryDynamicTools;
}

export function resolveMemoryDynamicTool(
  profile: MemoryToolProfile,
  namespace: unknown,
  tool: unknown,
  argumentsValue: unknown,
): MemoryDynamicTool | undefined {
  if (profile === "combined-v1") {
    return namespace === "memory" && isMemoryDynamicTool(tool) ? tool : undefined;
  }
  if (profile === "hook-v1") {
    if (namespace === "memory" && (tool === "retain" || tool === "recall")) return tool;
    if (namespace === "strategy" && tool === "update") return record(argumentsValue).content === null ? "clear_strategy" : "update_strategy";
    return undefined;
  }
  if (namespace === "memory" && (tool === "retain" || tool === "recall" || tool === "reflect")) return tool;
  if (namespace !== "strategy") return undefined;
  if (tool === "get") return "get_strategy";
  if (tool === "update") return record(argumentsValue).content === null ? "clear_strategy" : "update_strategy";
  return undefined;
}

type StrategyEvent = {
  readonly id: string;
  readonly roundId: number;
  readonly action: "update" | "clear";
  readonly occurredAt: string;
};

function strategyBankId(bankId: string): string {
  return `${bankId}-strategies`;
}

function isMemoryDynamicTool(value: unknown): value is MemoryDynamicTool {
  return value === "retain"
    || value === "recall"
    || value === "reflect"
    || value === "get_strategy"
    || value === "update_strategy"
    || value === "clear_strategy";
}

function strategyEventId(roundId: number, action: "update" | "clear", callId?: string): string {
  const suffix = safeId(callId ?? randomUUID());
  return `round-${String(roundId).padStart(6, "0")}-strategy-${action}-${suffix}`;
}

function strategyEvent(value: unknown): StrategyEvent | undefined {
  const item = recordOrEmpty(value);
  const id = typeof item.id === "string" ? item.id : typeof item.document_id === "string" ? item.document_id : undefined;
  if (!id) return undefined;
  const parsed = /^round-(\d{6})-strategy-(update|clear)-/.exec(id);
  if (!parsed) return undefined;
  const occurredAt = typeof item.created_at === "string" ? item.created_at : "";
  return { id, roundId: Number(parsed[1]), action: parsed[2] as "update" | "clear", occurredAt };
}

function compareStrategyEvents(left: StrategyEvent, right: StrategyEvent): number {
  return left.roundId - right.roundId
    || left.occurredAt.localeCompare(right.occurredAt)
    || left.id.localeCompare(right.id);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory tool arguments must be an object");
  return value as Record<string, unknown>;
}
function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
  return value;
}
function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} must be a string of at most ${max} characters`);
  return value;
}
function budgetValue(value: unknown): "low" | "mid" | "high" {
  if (value === undefined) return "low";
  if (value !== "low" && value !== "mid" && value !== "high") throw new Error("budget must be low, mid, or high");
  return value;
}
function positiveInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer from ${min} through ${max}`);
  return value as number;
}
export function normalizeRecallResponse(value: unknown, maxTokens: number): { memories: Array<{ content: string; context?: string }> } {
  const root = recordOrEmpty(value);
  const candidates = Array.isArray(root.memories)
    ? root.memories
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(value)
        ? value
        : [];
  const maxCharacters = maxTokens * 4;
  let remaining = maxCharacters;
  const memories: Array<{ content: string; context?: string }> = [];
  for (const candidate of candidates) {
    const item = recordOrEmpty(candidate);
    const content = firstText(item.content, item.text, item.original_text);
    if (!content || remaining <= 0) continue;
    const context = firstText(item.context, recordOrEmpty(item.retain_params).context);
    const boundedContent = content.slice(0, remaining);
    remaining -= boundedContent.length;
    const boundedContext = context && remaining > 0 ? context.slice(0, remaining) : undefined;
    remaining -= boundedContext?.length ?? 0;
    memories.push({ content: boundedContent, ...(boundedContext ? { context: boundedContext } : {}) });
  }
  return { memories };
}
function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
}
