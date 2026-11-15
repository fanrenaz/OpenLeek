import type { Account, FinancialInitialStatePresetDraft, FinancialInitialStatePresetVersion, MarketCheckpoint, MarketFacts, MarketMakerDraft, MarketMakerSelection, MarketMakerVersion, Order, Trade } from "../domain/models";
import type { AssetTombstone } from "@openleek/contracts/assets";
import type { IdempotencyRecord } from "./idempotency";

export interface PersistedMarketRun {
  runId: string;
  referencePrice: number;
  priceScale?: number;
  tickSizeUnits?: number;
  accounts: Account[];
  orders: Order[];
  trades: Trade[];
  sequence: number;
  publishedRound: number;
  marketMaker?: MarketMakerSelection;
  sealed: PersistedSeal[];
}

export interface PersistedSeal {
  checkpoint: MarketCheckpoint;
  facts: MarketFacts;
  /** Material market state as it was at seal time, used for exact forks. */
  material: MaterialMarketState;
}

export interface MaterialMarketState {
  symbol?: string;
  referencePrice: number;
  /** Missing on legacy Runs, where both values are implicitly 1. */
  priceScale?: number;
  tickSizeUnits?: number;
  accounts: Account[];
  orders: Order[];
  trades: Trade[];
  sequence: number;
  publishedRound: number;
  marketMaker?: MarketMakerSelection;
}

export interface FinancialMarketSnapshot {
  /** Version 2 deliberately rejects legacy liquidityPolicy state. */
  version: 2;
  runs: PersistedMarketRun[];
  idempotency: IdempotencyRecord[];
  marketMakerRegistry: MarketMakerRegistry;
  financialInitialStatePresetRegistry?: FinancialInitialStatePresetRegistry;
}

export interface FinancialInitialStatePresetRegistry { drafts: Record<string, FinancialInitialStatePresetDraft>; versions: Record<string, FinancialInitialStatePresetVersion>; tombstones?: AssetTombstone[]; }

export interface MarketMakerRegistry {
  drafts: Record<string, MarketMakerDraft>;
  versions: Record<string, MarketMakerVersion>;
  tombstones?: AssetTombstone[];
}

export interface FinancialMarketStateStore {
  load(): Promise<FinancialMarketSnapshot | undefined>;
  loadSeal(runId: string, roundId: number): Promise<PersistedSeal | undefined>;
  save(snapshot: FinancialMarketSnapshot): Promise<void>;
}
