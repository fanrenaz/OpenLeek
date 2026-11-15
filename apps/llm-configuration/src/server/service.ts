import {
  applyPatch,
  createResource,
  deleteResource,
  graphFor,
  resolvedProfile,
  revisionFor,
  resourceKindSchema,
  validateConfig,
  type ConfigGraph,
  type PatchRequest,
  type PatchResponse,
  type ResourceKind,
} from "./model";
import type { ConfigStore } from "./store";

export class LlmConfigurationService {
  constructor(private readonly store: ConfigStore) {}

  async initialize(bootstrap: () => Promise<import("./model").FullConfig>) {
    await this.store.migrate();
    if (!await this.store.current()) {
      const config = await bootstrap();
      const errors = validateConfig(config);
      if (errors.length) throw new Error(`bootstrap LLM configuration is invalid: ${errors.map((item) => item.message).join("; ")}`);
      await this.store.commit(config);
    }
  }

  async graph(): Promise<ConfigGraph> {
    const snapshot = await this.requiredCurrent();
    return graphFor(snapshot.config, snapshot.revision);
  }

  async validate(request: PatchRequest): Promise<PatchResponse> {
    const current = await this.requiredCurrent();
    if (request.baseRevision !== current.revision) return conflict(current.revision);
    let candidate;
    try {
      candidate = applyPatch(current.config, request);
    } catch (error) {
      return rejected(current.revision, message(error));
    }
    const errors = validateConfig(candidate);
    if (errors.length) return { result: "validationRejected", revision: current.revision, errors };
    const revision = revisionFor(candidate);
    return { result: "committed", revision, graph: graphFor(candidate, revision) };
  }

  async patch(request: PatchRequest): Promise<PatchResponse> {
    const current = await this.requiredCurrent();
    if (request.baseRevision !== current.revision) return conflict(current.revision);
    let candidate;
    try {
      candidate = applyPatch(current.config, request);
    } catch (error) {
      return rejected(current.revision, message(error));
    }
    const errors = validateConfig(candidate);
    if (errors.length) return { result: "validationRejected", revision: current.revision, errors };
    const committed = await this.store.commit(candidate, current.revision);
    if (!committed.committed) return conflict(committed.snapshot.revision);
    return { result: "committed", revision: committed.snapshot.revision, graph: graphFor(committed.snapshot.config, committed.snapshot.revision) };
  }

  async create(kindValue: string, input: { baseRevision: string; id: string; value: Record<string, unknown> }) {
    const kind = resourceKindSchema.parse(kindValue);
    const current = await this.requiredCurrent();
    if (input.baseRevision !== current.revision) return conflict(current.revision);
    let candidate;
    try {
      candidate = createResource(current.config, kind, input.id, input.value);
    } catch (error) {
      return rejected(current.revision, message(error), kind, input.id);
    }
    const errors = validateConfig(candidate);
    if (errors.length) return { result: "validationRejected" as const, revision: current.revision, errors };
    const committed = await this.store.commit(candidate, current.revision);
    if (!committed.committed) return conflict(committed.snapshot.revision);
    return { result: "committed" as const, revision: committed.snapshot.revision, graph: graphFor(committed.snapshot.config, committed.snapshot.revision) };
  }

  async delete(kindValue: string, id: string, baseRevision: string) {
    const kind = resourceKindSchema.parse(kindValue);
    const current = await this.requiredCurrent();
    if (baseRevision !== current.revision) return conflict(current.revision);
    let candidate;
    try {
      candidate = deleteResource(current.config, kind, id);
    } catch (error) {
      return rejected(current.revision, message(error), kind, id);
    }
    const errors = validateConfig(candidate);
    if (errors.length) return { result: "validationRejected" as const, revision: current.revision, errors };
    const committed = await this.store.commit(candidate, current.revision);
    if (!committed.committed) return conflict(committed.snapshot.revision);
    return { result: "committed" as const, revision: committed.snapshot.revision, graph: graphFor(committed.snapshot.config, committed.snapshot.revision) };
  }

  async capability() {
    const current = await this.requiredCurrent();
    const defaults = current.config.resources.find((resource) => resource.kind === "defaults" && resource.id === "main");
    if (!defaults || typeof defaults.value.model !== "string" || typeof defaults.value.memory_route !== "string") {
      throw new Error("LLM defaults are invalid");
    }
    const agent = resolvedProfile(current.config, defaults.value.model);
    return {
      revision: current.revision,
      model: defaults.value.model,
      resolvedModel: agent.model,
      memoryRoute: defaults.value.memory_route,
    };
  }

  async profile(revision: string, route: string) {
    const snapshot = await this.store.get(revision);
    if (!snapshot) return undefined;
    return { revision, ...resolvedProfile(snapshot.config, route) };
  }

  async currentProfile(route?: string) {
    const snapshot = await this.requiredCurrent();
    const defaults = snapshot.config.resources.find((resource) => resource.kind === "defaults" && resource.id === "main");
    const routeId = route ?? String(defaults?.value.model ?? "");
    return { revision: snapshot.revision, ...resolvedProfile(snapshot.config, routeId) };
  }

  private async requiredCurrent() {
    const current = await this.store.current();
    if (!current) throw new Error("LLM configuration is not initialized");
    return current;
  }
}

function conflict(revision: string): PatchResponse {
  return {
    result: "revisionConflict",
    revision,
    errors: [{ resourceKind: "defaults", resourceId: "main", code: "revisionConflict", message: "base revision does not match current revision" }],
  };
}

function rejected(revision: string, detail: string, kind: ResourceKind = "defaults", id = "main"): PatchResponse {
  return {
    result: "validationRejected",
    revision,
    errors: [{ resourceKind: kind, resourceId: id, code: "invalidChange", message: detail }],
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
