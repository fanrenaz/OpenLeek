import type {
  FeedAlgorithmExecutor,
  FeedAlgorithmValidation,
} from "./feed-algorithm-executor";
import type { FeedAlgorithmLimits } from "../domain/models";

/** HTTP adapter for the isolated Python 3.12 runner. It sends facts, never credentials. */
export class HttpFeedAlgorithmExecutor implements FeedAlgorithmExecutor {
  constructor(private readonly baseUrl: string) {}

  async validate(input: { source: string; limits: FeedAlgorithmLimits; dependencies: readonly string[] }): Promise<FeedAlgorithmValidation> {
    const value = await this.request("/validate", input, input.limits.maxRuntimeMs);
    if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).valid !== "boolean") {
      throw new Error("algorithm-runner returned an invalid validation response");
    }
    const result = value as Record<string, unknown>;
    return {
      valid: result.valid as boolean,
      ...(isRecord(result.configSchema) ? { configSchema: result.configSchema } : {}),
      ...(isRecord(result.defaultConfig) ? { defaultConfig: result.defaultConfig } : {}),
      errors: Array.isArray(result.errors) ? result.errors.filter((error): error is string => typeof error === "string") : [],
    };
  }

  async execute(input: Parameters<FeedAlgorithmExecutor["execute"]>[0]) {
    const value = await this.request("/execute", input, input.limits.maxRuntimeMs);
    if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).feeds)) {
      throw new Error("algorithm-runner returned an invalid execution response");
    }
    const feeds = (value as { feeds: unknown[] }).feeds.map((feed) => {
      if (!isRecord(feed) || typeof feed.actorId !== "string" || !Array.isArray(feed.postIds) || !feed.postIds.every((postId) => typeof postId === "string")) {
        throw new Error("algorithm-runner returned an invalid ranked feed");
      }
      return {
        actorId: feed.actorId,
        postIds: [...feed.postIds],
      };
    });
    return { feeds };
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
      const text = await response.text();
      let value: unknown = undefined;
      try { value = text ? JSON.parse(text) : undefined; } catch { throw new Error("algorithm-runner returned invalid JSON"); }
      if (!response.ok) {
        const message = isRecord(value) && typeof value.error === "string" ? value.error : `algorithm-runner failed (${response.status})`;
        throw new Error(message);
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
