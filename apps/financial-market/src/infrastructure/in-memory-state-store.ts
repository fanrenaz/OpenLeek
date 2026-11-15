import { clone } from "../application/idempotency";
import type { FinancialMarketSnapshot, FinancialMarketStateStore } from "../application/persistence";

/** Test double with the same restart boundary as a durable state store. */
export class InMemoryFinancialMarketStateStore implements FinancialMarketStateStore {
  private value?: FinancialMarketSnapshot;

  async load(): Promise<FinancialMarketSnapshot | undefined> {
    return this.value === undefined ? undefined : clone(this.value);
  }

  async loadSeal(runId: string, roundId: number) {
    return clone(this.value?.runs.find((run) => run.runId === runId)?.sealed.find((seal) => seal.checkpoint.roundId === roundId));
  }

  async save(snapshot: FinancialMarketSnapshot): Promise<void> {
    this.value = clone(snapshot);
  }
}
