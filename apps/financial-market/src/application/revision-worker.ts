import type { FinancialRevisionService } from "./revision-service";

/** Sequential Financial microbatch executor used by the Redis worker and owner tests. */
export class FinancialMarketWorktreeWorker {
  constructor(private readonly revisions: FinancialRevisionService) {}

  async runOnce(input: { runId: string; roundId: number }): Promise<{ commandId: string; status: "applied" | "rejected" } | undefined> {
    return this.revisions.processNextIntent(input.runId, input.roundId);
  }

  async drain(input: { runId: string; roundId: number }): Promise<number> {
    let processed = 0;
    while (await this.runOnce(input)) processed += 1;
    return processed;
  }
}
