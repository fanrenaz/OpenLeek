import { createHash } from "node:crypto";
import { z } from "zod";

export const resourceKindSchema = z.enum(["defaults", "model", "provider", "provider_offer", "route"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

const idSchema = z.string().regex(/^[A-Za-z0-9._/()+:-]{1,240}$/);
const protocolSchema = z.enum(["anthropic", "openai-chat", "google-genai", "openai-response"]);
const valueSchema = z.record(z.string(), z.unknown());

export interface FieldSchema {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  label: string;
  required?: boolean;
  secret?: boolean;
  control?: string;
  enum?: string[];
  hotReloadable: true;
  runtimeImpact?: "normal" | "critical";
}

export interface ConfigResource {
  kind: ResourceKind;
  id: string;
  label: string;
  value: Record<string, unknown>;
  schema: { fields: FieldSchema[] };
  status: "saved";
  runtimeImpact: "normal" | "critical";
  hotReloadable: true;
  references?: Array<{ kind: ResourceKind; id: string }>;
}

export interface ConfigGraph {
  revision: string;
  resources: ConfigResource[];
  validation: { valid: boolean; errors?: ConfigError[] };
  runtime: { status: "ok" };
  capabilities: { autosave: true; logs: false };
}

export interface ConfigError {
  resourceKind: ResourceKind;
  resourceId: string;
  field?: string;
  code: string;
  message: string;
}

export interface FullConfig {
  resources: Array<{ kind: ResourceKind; id: string; value: Record<string, unknown> }>;
}

export interface PatchRequest {
  baseRevision: string;
  changes: Array<{ kind: ResourceKind; id: string; field: string; value: unknown }>;
}

export type PatchResponse = {
  result: "committed" | "revisionConflict" | "validationRejected";
  revision: string;
  graph?: ConfigGraph;
  errors?: ConfigError[];
};

const schemaByKind: Record<ResourceKind, FieldSchema[]> = {
  defaults: [
    field("model", "string", "Default Agent Route", { required: true, critical: true }),
    field("memory_route", "string", "Memory Route", { required: true, critical: true }),
    field("max_tokens", "number", "Default Max Tokens"),
  ],
  provider: [
    field("base_url", "string", "Base URL", { required: true, critical: true }),
    field("api_key", "string", "API Key", { required: true, secret: true, critical: true }),
    field("protocol", "string", "Protocol", { required: true, critical: true, control: "select", enum: protocolSchema.options }),
    field("version", "string", "Version"),
    field("user_agent", "string", "User Agent"),
    field("web_search", "object", "Web Search"),
    field("extensions", "object", "Extensions"),
  ],
  model: [
    field("context_window", "number", "Context Window", { required: true }),
    field("max_output_tokens", "number", "Max Output Tokens"),
    field("supports_reasoning", "boolean", "Supports Reasoning"),
    field("default_reasoning_level", "string", "Default Reasoning Level"),
    field("supported_reasoning_levels", "array", "Supported Reasoning Levels"),
    field("supports_reasoning_summaries", "boolean", "Supports Reasoning Summaries"),
    field("default_reasoning_summary", "string", "Default Reasoning Summary"),
    field("input_modalities", "array", "Input Modalities"),
    field("supports_image_detail_original", "boolean", "Supports Original Image Detail"),
    field("supports_parallel_tool_calls", "boolean", "Supports Parallel Tool Calls"),
    field("web_search", "object", "Web Search"),
    field("extensions", "object", "Extensions"),
  ],
  provider_offer: [
    field("provider", "string", "Provider", { required: true, critical: true }),
    field("model", "string", "Model", { required: true, critical: true }),
    field("pricing", "object", "Pricing"),
  ],
  route: [
    field("provider", "string", "Provider", { required: true, critical: true }),
    field("model", "string", "Model", { required: true, critical: true }),
    field("context_window", "number", "Context Window"),
    field("max_output_tokens", "number", "Max Output Tokens"),
    field("reasoning_level", "string", "Reasoning Level"),
    field("web_search", "object", "Web Search"),
    field("extensions", "object", "Extensions"),
  ],
};

function field(
  path: string,
  type: FieldSchema["type"],
  label: string,
  options: { required?: boolean; secret?: boolean; critical?: boolean; control?: string; enum?: string[] } = {},
): FieldSchema {
  return {
    path,
    type,
    label,
    hotReloadable: true,
    runtimeImpact: options.critical ? "critical" : "normal",
    ...(options.required ? { required: true } : {}),
    ...(options.secret ? { secret: true, control: "secret" } : {}),
    ...(options.control ? { control: options.control } : {}),
    ...(options.enum ? { enum: options.enum } : {}),
  };
}

export function parseFullConfig(value: unknown): FullConfig {
  const parsed = z.object({
    resources: z.array(z.object({
      kind: resourceKindSchema,
      id: idSchema,
      value: valueSchema,
    }).strict()).min(1),
  }).strict().parse(value);
  return { resources: parsed.resources.map((resource) => ({ ...resource, value: structuredClone(resource.value) })) };
}

export function normalizeConfig(config: FullConfig): FullConfig {
  const resources = config.resources
    .map((resource) => ({ kind: resource.kind, id: resource.id, value: sortObject(resource.value) }))
    .sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
  return { resources };
}

export function revisionFor(config: FullConfig): string {
  return `revision:llm:${createHash("sha256").update(JSON.stringify(normalizeConfig(config))).digest("hex")}`;
}

export function validateConfig(config: FullConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const resources = new Map(config.resources.map((resource) => [`${resource.kind}/${resource.id}`, resource]));
  const defaults = resources.get("defaults/main");
  if (!defaults) {
    errors.push(error("defaults", "main", "missing", "defaults/main is required"));
  } else {
    for (const fieldName of ["model", "memory_route"] as const) {
      const routeId = defaults.value[fieldName];
      if (typeof routeId !== "string" || !resources.has(`route/${routeId}`)) {
        errors.push(error("defaults", "main", "missingReference", `${fieldName} must reference an existing route`, fieldName));
      }
    }
  }
  for (const resource of config.resources) {
    const fields = schemaByKind[resource.kind];
    const allowed = new Set(fields.map((candidate) => candidate.path));
    for (const key of Object.keys(resource.value)) {
      if (!allowed.has(key)) errors.push(error(resource.kind, resource.id, "unknownField", `unknown field ${key}`, key));
    }
    for (const candidate of fields.filter((fieldSchema) => fieldSchema.required)) {
      const value = resource.value[candidate.path];
      if (value === undefined || value === null || value === "") {
        errors.push(error(resource.kind, resource.id, "required", `${candidate.path} is required`, candidate.path));
      }
    }
    if (resource.kind === "provider") {
      const parsed = protocolSchema.safeParse(resource.value.protocol ?? "anthropic");
      if (!parsed.success) errors.push(error(resource.kind, resource.id, "invalidProtocol", "unsupported provider protocol", "protocol"));
    }
    if (resource.kind === "route") {
      reference(errors, resources, resource, "provider", "provider");
      reference(errors, resources, resource, "model", "model");
    }
    if (resource.kind === "provider_offer") {
      reference(errors, resources, resource, "provider", "provider");
      reference(errors, resources, resource, "model", "model");
    }
  }
  const memoryRouteId = defaults?.value.memory_route;
  const memoryRoute = typeof memoryRouteId === "string" ? resources.get(`route/${memoryRouteId}`) : undefined;
  const memoryProviderId = memoryRoute?.value.provider;
  const memoryProvider = typeof memoryProviderId === "string" ? resources.get(`provider/${memoryProviderId}`) : undefined;
  const protocol = memoryProvider?.value.protocol ?? "anthropic";
  if (memoryRoute && !["anthropic", "openai-chat", "google-genai"].includes(String(protocol))) {
    errors.push(error("route", memoryRoute.id, "unsupportedMemoryProtocol", "memory route must use anthropic, openai-chat, or google-genai", "provider"));
  }
  return errors;
}

export function graphFor(config: FullConfig, revision: string, includeSecrets = false): ConfigGraph {
  const errors = validateConfig(config);
  const resources = config.resources.map((resource) => {
    const references: Array<{ kind: ResourceKind; id: string }> = [];
    if (resource.kind === "route" || resource.kind === "provider_offer") {
      if (typeof resource.value.provider === "string") references.push({ kind: "provider", id: resource.value.provider });
      if (typeof resource.value.model === "string") references.push({ kind: "model", id: resource.value.model });
    }
    return {
      kind: resource.kind,
      id: resource.id,
      label: resource.id,
      value: includeSecrets ? structuredClone(resource.value) : redact(resource.kind, resource.value),
      schema: { fields: schemaByKind[resource.kind] },
      status: "saved" as const,
      runtimeImpact: resource.kind === "provider" || resource.kind === "route" ? "critical" as const : "normal" as const,
      hotReloadable: true as const,
      ...(references.length ? { references } : {}),
    };
  });
  return {
    revision,
    resources,
    validation: errors.length ? { valid: false, errors } : { valid: true },
    runtime: { status: "ok" },
    capabilities: { autosave: true, logs: false },
  };
}

export function applyPatch(config: FullConfig, request: PatchRequest): FullConfig {
  const next = normalizeConfig(config);
  for (const change of request.changes) {
    const resource = next.resources.find((candidate) => candidate.kind === change.kind && candidate.id === change.id);
    if (!resource) throw new Error(`resource ${change.kind}/${change.id} does not exist`);
    const schema = schemaByKind[change.kind].find((candidate) => candidate.path === change.field);
    if (!schema) throw new Error(`field ${change.kind}/${change.id}/${change.field} does not exist`);
    if (schema.secret && change.value === "******") continue;
    resource.value[change.field] = structuredClone(change.value);
  }
  return normalizeConfig(next);
}

export function createResource(config: FullConfig, kind: ResourceKind, id: string, value: Record<string, unknown>): FullConfig {
  idSchema.parse(id);
  if (config.resources.some((resource) => resource.kind === kind && resource.id === id)) throw new Error(`resource ${kind}/${id} already exists`);
  return normalizeConfig({ resources: [...config.resources, { kind, id, value: structuredClone(value) }] });
}

export function deleteResource(config: FullConfig, kind: ResourceKind, id: string): FullConfig {
  if (kind === "defaults") throw new Error("defaults/main cannot be deleted");
  const next = config.resources.filter((resource) => !(resource.kind === kind && resource.id === id));
  if (next.length === config.resources.length) throw new Error(`resource ${kind}/${id} does not exist`);
  return normalizeConfig({ resources: next });
}

export function resolvedProfile(config: FullConfig, routeId: string) {
  const resource = (kind: ResourceKind, id: unknown) => {
    if (typeof id !== "string") throw new Error(`${kind} reference is missing`);
    const found = config.resources.find((candidate) => candidate.kind === kind && candidate.id === id);
    if (!found) throw new Error(`${kind}/${id} does not exist`);
    return found;
  };
  const route = resource("route", routeId);
  const provider = resource("provider", route.value.provider);
  const model = resource("model", route.value.model);
  return {
    routeId,
    providerId: provider.id,
    protocol: String(provider.value.protocol ?? "anthropic"),
    baseUrl: String(provider.value.base_url ?? ""),
    apiKey: String(provider.value.api_key ?? ""),
    version: typeof provider.value.version === "string" ? provider.value.version : undefined,
    model: model.id,
    route: structuredClone(route.value),
    modelConfiguration: structuredClone(model.value),
  };
}

function reference(
  errors: ConfigError[],
  resources: Map<string, { kind: ResourceKind; id: string; value: Record<string, unknown> }>,
  resource: { kind: ResourceKind; id: string; value: Record<string, unknown> },
  fieldName: string,
  targetKind: ResourceKind,
) {
  const id = resource.value[fieldName];
  if (typeof id !== "string" || !resources.has(`${targetKind}/${id}`)) {
    errors.push(error(resource.kind, resource.id, "missingReference", `${fieldName} must reference an existing ${targetKind}`, fieldName));
  }
}

function error(kind: ResourceKind, id: string, code: string, message: string, fieldName?: string): ConfigError {
  return { resourceKind: kind, resourceId: id, code, message, ...(fieldName ? { field: fieldName } : {}) };
}

function redact(kind: ResourceKind, value: Record<string, unknown>) {
  const next = structuredClone(value);
  if (kind === "provider" && "api_key" in next) next.api_key = "******";
  return next;
}

function sortObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortObject) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortObject(child)])) as T;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value as Record<string, unknown>) : {};
}
