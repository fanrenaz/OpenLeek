import type { MarketMakerLimits, MarketMakerOrderIntent, MarketMakerTiming } from "../domain/models";

export interface MarketMakerValidation {
  valid: boolean;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  errors: string[];
}

/**
 * Financial's narrow outbound port to the isolated Python runner.  The
 * endpoint/capability pair is a dedicated internal history reader, never an
 * Agent MCP bearer or snapshot payload.
 */
export interface MarketMakerExecutor {
  validate(input: {
    source: string;
    limits: MarketMakerLimits;
    dependencies: readonly string[];
  }): Promise<MarketMakerValidation>;
  execute(input: {
    source: string;
    config: Record<string, unknown>;
    seed: string;
    roundId: number;
    timing: MarketMakerTiming;
    financialHistory: { endpoint: string; capability: string };
    limits: MarketMakerLimits;
    dependencies: readonly string[];
  }): Promise<{ orders: MarketMakerOrderIntent[] }>;
}

/** Used in tests and deployments that have not enabled the Python runner. */
export class UnavailableMarketMakerExecutor implements MarketMakerExecutor {
  async validate(): Promise<MarketMakerValidation> {
    return { valid: false, errors: ["algorithm-runner is not configured"] };
  }

  async execute(): Promise<{ orders: MarketMakerOrderIntent[] }> {
    throw new Error("algorithm-runner is not configured");
  }
}
