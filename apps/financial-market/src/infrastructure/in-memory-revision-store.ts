import { clone } from "../application/idempotency";
import type { FinancialRevisionState, FinancialRevisionStore } from "../application/revision-store";

/** Test double with the same whole-record durability boundary as Postgres. */
export class InMemoryFinancialRevisionStore implements FinancialRevisionStore {
  private value?: FinancialRevisionState;

  async load(): Promise<FinancialRevisionState | undefined> {
    return this.value === undefined ? undefined : clone(this.value);
  }

  async loadRevision(revisionRef: string) {
    for (const run of Object.values(this.value?.runs ?? {})) {
      const revision = run.revisions[revisionRef];
      if (revision !== undefined) return clone(revision);
    }
    return undefined;
  }

  async save(state: FinancialRevisionState): Promise<void> {
    this.value = clone(state);
  }
}
