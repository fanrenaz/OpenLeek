import type { ResolvedProfileMember, WorldGeneratorPort } from "./model";

/** HTTP adapter for the credentialless Python algorithm-runner. */
export class HttpWorldGenerator implements WorldGeneratorPort {
  constructor(private readonly baseUrl: string) {}

  async validate(input: Parameters<WorldGeneratorPort["validate"]>[0]) {
    const value = await this.request(`/world-generator/${input.kind}/validate`, input, input.limits.maxRuntimeMs);
    if (!isRecord(value) || typeof value.valid !== "boolean") throw new Error("algorithm-runner returned an invalid world generator validation response");
    return {
      valid: value.valid,
      ...(isRecord(value.configSchema) ? { configSchema: value.configSchema } : {}),
      ...(isRecord(value.defaultConfig) ? { defaultConfig: value.defaultConfig } : {}),
      errors: Array.isArray(value.errors) ? value.errors.filter((error): error is string => typeof error === "string") : [],
    };
  }

  async executePopulation(input: { source: string; dependencies: readonly string[]; limits: { maxRuntimeMs: number; maxMemoryMb: number }; config: Record<string, unknown>; seed: string; instruments: readonly { symbol: string; referencePrice: number }[] }): Promise<unknown> {
    return this.request("/world-generator/population/execute", input, input.limits.maxRuntimeMs);
  }

  async executeNetwork(input: { source: string; dependencies: readonly string[]; limits: { maxRuntimeMs: number; maxMemoryMb: number }; config: Record<string, unknown>; seed: string; population: readonly ResolvedProfileMember[] }): Promise<unknown> {
    return this.request("/world-generator/network/execute", input, input.limits.maxRuntimeMs);
  }

  private async request(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 1_000);
    try {
      const response = await fetch(new URL(path, `${this.baseUrl.replace(/\/$/, "")}/`), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let value: unknown;
      try { value = raw ? JSON.parse(raw) : undefined; } catch { throw new Error("algorithm-runner returned invalid JSON"); }
      if (!response.ok) throw new Error(isRecord(value) && typeof value.error === "string" ? value.error : `algorithm-runner failed (${response.status})`);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
