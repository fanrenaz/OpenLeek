import type { MarketMakerOrderIntent } from "../domain/models";
import type { MarketMakerExecutor, MarketMakerValidation } from "./market-maker-executor";

/** HTTP adapter for the isolated dual-mode Python algorithm runner. */
export class HttpMarketMakerExecutor implements MarketMakerExecutor {
  constructor(private readonly baseUrl: string) {}

  async validate(input: Parameters<MarketMakerExecutor["validate"]>[0]): Promise<MarketMakerValidation> {
    const value = await this.request("/market-maker/validate", input, input.limits.maxRuntimeMs);
    if (!isRecord(value) || typeof value.valid !== "boolean") {
      throw new Error("algorithm-runner returned an invalid validation response");
    }
    return {
      valid: value.valid,
      ...(isRecord(value.configSchema) ? { configSchema: value.configSchema } : {}),
      ...(isRecord(value.defaultConfig) ? { defaultConfig: value.defaultConfig } : {}),
      errors: Array.isArray(value.errors) ? value.errors.filter((item): item is string => typeof item === "string") : [],
    };
  }

  async execute(input: Parameters<MarketMakerExecutor["execute"]>[0]): Promise<{ orders: MarketMakerOrderIntent[] }> {
    const value = await this.request("/market-maker/execute", input, input.limits.maxRuntimeMs);
    if (!isRecord(value) || !Array.isArray(value.orders)) {
      throw new Error("algorithm-runner returned an invalid execution response");
    }
    const orders = value.orders.map((order) => normalizeOrder(order));
    return { orders };
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
      let value: unknown;
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

function normalizeOrder(value: unknown): MarketMakerOrderIntent {
  if (!isRecord(value) || (value.side !== "buy" && value.side !== "sell") || !positiveNumber(value.limitPrice) || !positiveInteger(value.quantity)) {
    throw new Error("algorithm-runner returned an invalid order intent");
  }
  return { side: value.side, limitPrice: value.limitPrice, quantity: value.quantity };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
