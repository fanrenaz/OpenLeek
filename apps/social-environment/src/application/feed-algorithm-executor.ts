import type { FeedAlgorithmLimits } from "../domain/models";

export interface FeedAlgorithmRankedFeed {
  actorId: string;
  postIds: string[];
}

export interface FeedAlgorithmValidation {
  valid: boolean;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  errors: string[];
}

/**
 * Social's narrow outbound port. The executor owns no Social facts and is
 * never allowed to choose canonical IDs or write a Context database.
 */
export interface FeedAlgorithmExecutor {
  validate(input: { source: string; limits: FeedAlgorithmLimits; dependencies: readonly string[] }): Promise<FeedAlgorithmValidation>;
  execute(input: {
    source: string;
    config: Record<string, unknown>;
    seed: string;
    roundId: number;
    /** Control metadata only; Social facts stay behind the history reader. */
    feedSize: number;
    /** Active actors that require exactly one ranked feed. */
    actorIds: string[];
    /** Dedicated runner-only committed Social history reader. */
    socialHistory: { endpoint: string; capability: string };
    limits: FeedAlgorithmLimits;
    dependencies: readonly string[];
  }): Promise<{ feeds: FeedAlgorithmRankedFeed[] }>;
}

/** Used only in unit tests and deployments that have not enabled custom code. */
export class UnavailableFeedAlgorithmExecutor implements FeedAlgorithmExecutor {
  async validate(): Promise<FeedAlgorithmValidation> {
    return { valid: false, errors: ["algorithm-runner is not configured"] };
  }

  async execute(): Promise<{ feeds: FeedAlgorithmRankedFeed[] }> {
    throw new Error("algorithm-runner is not configured");
  }
}
