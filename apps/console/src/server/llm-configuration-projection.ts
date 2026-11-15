import { dataDictionarySourceSchema, type DataDictionarySource } from "@openleek/contracts/data-dictionary";
import { z } from "zod";

const llmConfigurationCapabilitySchema = z.object({
  model: z.string().min(1).max(240),
  revision: z.string().min(1).max(240),
  memoryRoute: z.string().min(1).max(240).default("memory"),
}).strict();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Build the run-creation capability from the graph's authoritative Defaults resource. */
export function llmConfigurationCapability(value: unknown) {
  const graph = asRecord(value);
  const revision = graph.revision;
  const resources = Array.isArray(graph.resources) ? graph.resources : [];
  const defaults = resources.find((resource) => {
    const record = asRecord(resource);
    return record.kind === "defaults" && record.id === "main";
  });
  const model = asRecord(asRecord(defaults).value).model;
  const memoryRoute = asRecord(asRecord(defaults).value).memory_route;
  return llmConfigurationCapabilitySchema.parse({ revision, model, ...(typeof memoryRoute === "string" ? { memoryRoute } : {}) });
}

const secretMask = "******";
function isSecretKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "apikey" || normalized === "authtoken" || normalized === "authorization" || normalized === "password"
    || normalized === "secret" || normalized === "token" || normalized === "credential" || normalized === "credentials"
    || normalized === "privatekey" || normalized.endsWith("apikey") || normalized.endsWith("authtoken");
}

/**
 * Defensive browser boundary for future extension and proxy fields.
 */
export function sanitizeLlmConfigurationForBrowser(value: unknown): unknown {
  const visit = (item: unknown, key?: string): unknown => {
    if (key && isSecretKey(key)) return secretMask;
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      visit(child, childKey),
    ]));
  };
  return visit(value);
}

const text = (en: string, zh: string) => ({ default: en, translations: { en, zh } });

export function llmConfigurationDataDictionary(value: unknown): DataDictionarySource {
  const graph = sanitizeLlmConfigurationForBrowser(value);
  const capability = llmConfigurationCapability(value);
  return dataDictionarySourceSchema.parse({
    schemaVersion: "1",
    ownerId: "llm-configuration",
    owner: text("LLM Configuration", "LLM 配置"),
    revision: capability.revision,
    entries: [
      {
        schemaVersion: "1",
        id: "llm-configuration-config-graph",
        ownerId: "llm-configuration",
        categoryId: "configuration",
        entryKind: "configuration",
        management: {
          surface: "llm-configuration",
          key: "config-graph",
          idField: "revision",
          capabilities: ["read", "validate", "patch", "create-resource", "delete-resource"],
        },
        label: text("LLM configuration graph", "LLM 配置图"),
        description: text("The current redacted Hindsight provider, model, offer, and route graph.", "当前已脱敏的 Hindsight Provider、模型、Offer 与路由配置图。"),
        definitionSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          required: ["revision", "resources"],
          properties: {
            revision: { type: "string", minLength: 1 },
            resources: { type: "array", items: { type: "object" } },
          },
          additionalProperties: true,
        },
        references: [],
        examples: [{ title: text("Current redacted graph", "当前脱敏配置图"), value: graph }],
      },
      {
        schemaVersion: "1",
        id: "llm-configuration-model-capability",
        ownerId: "llm-configuration",
        categoryId: "configuration",
        entryKind: "projection",
        management: { surface: "llm-configuration", key: "model-capability", idField: "revision", capabilities: ["read"] },
        label: text("Hindsight LLM capability", "Hindsight LLM 能力"),
        description: text("The memory route and revision bound to newly created Runs.", "创建新 Run 时绑定的 memory 路由与修订。"),
        definitionSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          required: ["model", "revision", "memoryRoute"],
          properties: {
            model: { type: "string", minLength: 1, maxLength: 240 },
            revision: { type: "string", minLength: 1, maxLength: 240 },
            memoryRoute: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
        references: [{ path: "revision", targetEntryId: "llm-configuration-config-graph" }],
        examples: [{ title: text("Current model capability", "当前模型能力"), value: capability }],
      },
    ],
  });
}
