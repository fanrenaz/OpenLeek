import type { SocialNetworkLimits } from "../domain/models";

export interface SocialNetworkValidation { valid: boolean; configSchema?: Record<string, unknown>; defaultConfig?: Record<string, unknown>; errors: string[]; }
export interface SocialNetworkParticipant { slotId: string; cohortKey: string; cohortIndex: number; actorId: string; }

export class HttpSocialNetworkExecutor {
  constructor(private readonly baseUrl: string) {}
  async validate(input: { source: string; dependencies: readonly string[]; limits: SocialNetworkLimits }): Promise<SocialNetworkValidation> {
    const value = await this.request("/world-generator/network/validate", input, input.limits.maxRuntimeMs);
    const record = object(value); if (typeof record.valid !== "boolean") throw new Error("algorithm-runner returned an invalid Social Network validation response");
    return { valid: record.valid, ...(isObject(record.configSchema) ? { configSchema: record.configSchema } : {}), ...(isObject(record.defaultConfig) ? { defaultConfig: record.defaultConfig } : {}), errors: Array.isArray(record.errors) ? record.errors.filter((item): item is string => typeof item === "string") : [] };
  }
  async execute(input: { source: string; dependencies: readonly string[]; limits: SocialNetworkLimits; config: Record<string, unknown>; seed: string; population: readonly SocialNetworkParticipant[] }): Promise<{ relationships: Array<{ followerSlotId: string; followeeSlotId: string }> }> {
    const value = object(await this.request("/world-generator/network/execute", input, input.limits.maxRuntimeMs));
    if (!Array.isArray(value.relationships)) throw new Error("algorithm-runner returned an invalid Social Network result");
    return { relationships: value.relationships.map((item) => { const relation = object(item); if (typeof relation.followerSlotId !== "string" || typeof relation.followeeSlotId !== "string") throw new Error("algorithm-runner returned an invalid Social Network relationship"); return { followerSlotId: relation.followerSlotId, followeeSlotId: relation.followeeSlotId }; }) };
  }
  private async request(path: string, body: unknown, timeoutMs: number): Promise<unknown> { const response = await fetch(new URL(path, `${this.baseUrl.replace(/\/$/, "")}/`), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs + 1_000) }); const text = await response.text(); let value: unknown; try { value = text ? JSON.parse(text) : undefined; } catch { throw new Error("algorithm-runner returned invalid JSON"); } if (!response.ok) throw new Error(isObject(value) && typeof value.error === "string" ? value.error : `algorithm-runner failed (${response.status})`); return value; }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function object(value: unknown): Record<string, unknown> { if (!isObject(value)) throw new Error("expected an object"); return value; }
