import type {
  FinancialMarketMakerHistoryCapability,
  FinancialMcpRunState,
  FinancialRoundWorkspace,
  StoredFinancialRevision,
} from "./revision-model";

/** JSON-shaped state that belongs only to the Financial Context. */
export interface FinancialRevisionState {
  version: 2;
  runs: Record<string, FinancialRevisionRunState>;
  marketMakerHistoryCapabilities: Record<string, FinancialMarketMakerHistoryCapability>;
}

export interface FinancialRevisionRunState {
  revisions: Record<string, StoredFinancialRevision>;
  revisionHeadRef?: string;
  roundWorkspaces: Record<string, FinancialRoundWorkspace>;
  mcp: FinancialMcpRunState;
}

export interface FinancialRevisionStore {
  load(): Promise<FinancialRevisionState | undefined>;
  loadRevision(revisionRef: string): Promise<StoredFinancialRevision | undefined>;
  save(state: FinancialRevisionState): Promise<void>;
}

export function hasFinancialRevisionSnapshot(
  revision: StoredFinancialRevision,
): revision is StoredFinancialRevision {
  return revision.snapshot !== undefined;
}

export function emptyFinancialRevisionState(): FinancialRevisionState {
  return { version: 2, runs: {}, marketMakerHistoryCapabilities: {} };
}
