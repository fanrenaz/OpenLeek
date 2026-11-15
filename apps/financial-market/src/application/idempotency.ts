import { idempotencyConflict, invalid } from "../domain/errors";

export interface IdempotencyRecord {
  transitionId: string;
  stepId: string;
  payloadDigest: string;
  result: unknown;
}

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  has(transitionId: string, stepId: string): boolean {
    return this.records.has(key(transitionId, stepId));
  }

  async execute<Result>(
    transitionId: string,
    stepId: string,
    payloadDigest: string,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    if (!transitionId.trim() || !stepId.trim()) {
      throw invalid("mutation requires transitionId and stepId", "mutation");
    }
    if (!payloadDigest.trim()) {
      throw invalid("mutation requires payloadDigest", "mutation.payloadDigest");
    }
    const existing = this.records.get(key(transitionId, stepId));
    if (existing !== undefined) {
      if (existing.payloadDigest !== payloadDigest) {
        throw idempotencyConflict(
          "transitionId and stepId already exist with a different payload digest",
        );
      }
      return clone(existing.result) as Result;
    }
    const result = await operation();
    this.records.set(key(transitionId, stepId), {
      transitionId,
      stepId,
      payloadDigest,
      result: clone(result),
    });
    return clone(result);
  }

  snapshot(): IdempotencyRecord[] {
    return [...this.records.values()]
      .sort((left, right) => key(left.transitionId, left.stepId).localeCompare(key(right.transitionId, right.stepId)))
      .map((record) => clone(record));
  }

  restore(records: readonly IdempotencyRecord[]): void {
    this.records.clear();
    for (const record of records) {
      if (!record.transitionId?.trim() || !record.stepId?.trim() || !record.payloadDigest?.trim()) {
        throw invalid("Financial Market idempotency snapshot is invalid");
      }
      this.records.set(key(record.transitionId, record.stepId), clone(record));
    }
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(transitionId: string, stepId: string): string {
  return JSON.stringify([transitionId, stepId]);
}
