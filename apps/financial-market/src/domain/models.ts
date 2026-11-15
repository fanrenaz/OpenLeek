import type { FinancialInitialStatePresetDefinition } from "@openleek/contracts/world";

/** Financial Market's context-owned types. Money/prices are fixed-point integers; quantity is whole units. */

export const orderSides = ["buy", "sell"] as const;
export type OrderSide = (typeof orderSides)[number];

type FinancialInitialStatePresetIdentity = {
  presetId: string;
  name: string;
};

export type FinancialInitialStatePresetDraft = FinancialInitialStatePresetDefinition & FinancialInitialStatePresetIdentity & {
  revision: number;
  updatedAt: string;
};

export type FinancialInitialStatePresetVersion = FinancialInitialStatePresetDefinition & FinancialInitialStatePresetIdentity & {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
};

export const timeInForces = ["gtc", "ioc", "fok"] as const;
export type TimeInForce = (typeof timeInForces)[number];

export interface MutationHeader {
  transitionId: string;
  stepId: string;
  payloadDigest: string;
  expectedCheckpointRef: string;
}

export interface AccountSeed {
  accountId: string;
  initialCash: number;
  initialPosition: number;
  maximumActionsPerRound: number;
  initialStatePresetVersionRef?: string;
}

export const marketMakerTimings = ["opening", "settlement"] as const;
export type MarketMakerTiming = (typeof marketMakerTimings)[number];

/** A published Financial-owned Market Maker selected for one run. */
export interface MarketMakerSelection {
  versionRef: string;
  accountId: string;
  timing: MarketMakerTiming;
  matchingPolicy?: "batch" | "incremental";
  requotePolicy?: "none" | "after_each_trade";
  maxRequotesPerIntent?: number;
  config: Record<string, unknown>;
}

export interface MarketMakerLimits {
  maxRuntimeMs: number;
  maxMemoryMb: number;
}

/** Mutable source record. Source is never embedded in an Experiment spec. */
export interface MarketMakerDraft {
  algorithmId: string;
  name: string;
  source: string;
  defaultConfig: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  dependencies: string[];
  limits: MarketMakerLimits;
  revision: number;
  updatedAt: string;
}

/** Immutable published source artifact eligible for run and fork selection. */
export interface MarketMakerVersion extends Omit<MarketMakerDraft, "revision" | "updatedAt"> {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
}

/** The entire semantic output contract of a MarketMaker class. */
export interface MarketMakerOrderIntent {
  side: OrderSide;
  limitPrice: number;
  quantity: number;
}

export interface FinancialMarketSection {
  symbol?: string;
  initialReferencePrice: number;
  priceScale?: number;
  tickSizeUnits?: number;
  accounts: readonly AccountSeed[];
  marketMaker?: MarketMakerSelection;
}

export interface Account {
  accountId: string;
  cash: number;
  position: number;
  maximumActionsPerRound: number;
  reservedCash: number;
  reservedPosition: number;
  initialStatePresetVersionRef?: string;
}

export interface Order {
  orderId: string;
  accountId: string;
  side: OrderSide;
  /** Missing on persisted v2 snapshots created before broker orders existed. */
  orderType?: "limit" | "market";
  quantity: number;
  remaining: number;
  limitPrice?: number;
  cashBudget?: number;
  createdSequence: number;
  expiresAtRound?: number;
  timeInForce: TimeInForce;
  status: OrderStatus;
  replacedByOrderId?: string;
  replacesOrderId?: string;
  /** Financial writes this provenance; agents cannot choose it. */
  origin: OrderOrigin;
}

export const orderOrigins = ["agent", "market_maker"] as const;
export type OrderOrigin = (typeof orderOrigins)[number];

export const orderStatuses = ["open", "filled", "cancelled", "expired", "replaced"] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export interface Trade {
  tradeId: string;
  buyOrderId: string;
  sellOrderId: string;
  quantity: number;
  price: number;
  roundId: number;
}

export interface MarketCheckpoint {
  ref: string;
  runId: string;
  roundId: number;
  digest: string;
}

export interface MarketObservation {
  accountId: string;
  lastTradePrice: number;
  bestBid: number;
  bestAsk: number;
  availableCash: number;
  availablePosition: number;
}

export interface MarketSummary {
  roundId: number;
  lastTradePrice: number;
  volume: number;
  bestBid: number;
  bestAsk: number;
  openOrderCount: number;
}

export interface SubmitOrder {
  type: "submitOrder";
  actionId: string;
  accountId: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  expiresAtRound?: number;
  timeInForce?: TimeInForce;
}

export interface SubmitMarketOrder {
  type: "submitMarketOrder";
  actionId: string;
  accountId: string;
  side: OrderSide;
  quantity: number;
  /** A hard notional cap for buy orders sized from cash or portfolio fraction. */
  cashBudget?: number;
  timeInForce: "ioc" | "fok";
}

export interface ReplaceOrder {
  type: "replaceOrder";
  actionId: string;
  accountId: string;
  orderId: string;
  replacementOrderId: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  expiresAtRound?: number;
  timeInForce?: TimeInForce;
}

export interface CancelOrder {
  type: "cancelOrder";
  actionId: string;
  accountId: string;
  orderId: string;
}

export type MarketAction = SubmitOrder | SubmitMarketOrder | ReplaceOrder | CancelOrder;

export interface MarketFacts {
  checkpoint: MarketCheckpoint;
  trades: Trade[];
  summary: MarketSummary;
}
