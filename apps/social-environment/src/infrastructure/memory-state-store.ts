import type { SocialState, SocialStateStore } from "../application/state-store";

export class InMemorySocialStateStore implements SocialStateStore {
  private state: SocialState | null = null;

  async load(): Promise<SocialState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async loadRevision(revisionRef: string) {
    for (const run of Object.values(this.state?.runs ?? {})) {
      const revision = run.revisions[revisionRef];
      if (revision !== undefined) return structuredClone(revision);
    }
    return undefined;
  }

  async save(state: SocialState): Promise<void> {
    this.state = structuredClone(state);
  }
}
