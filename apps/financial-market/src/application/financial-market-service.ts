import { randomUUID } from "node:crypto";
import { sha256Digest } from "@openleek/contracts/canonical";
import type { AssetDeletionResult, AssetDeleteTarget, AssetTombstone } from "@openleek/contracts/assets";
import {
  financialInitialStatePresetDefinitionSchema,
  type FinancialInitialStatePresetDefinition,
} from "@openleek/contracts/world";
import { invalid, notFound, precondition } from "../domain/errors";
import { priceToUnits, unitsForSnapshot, unitsToDecimal, type PriceUnits } from "../domain/price-units";
import type {
  Account,
  AccountSeed,
  CancelOrder,
  FinancialMarketSection,
  FinancialInitialStatePresetDraft,
  FinancialInitialStatePresetVersion,
  MarketAction,
  MarketCheckpoint,
  MarketFacts,
  MarketMakerDraft,
  MarketMakerLimits,
  MarketMakerOrderIntent,
  MarketMakerSelection,
  MarketMakerTiming,
  MarketMakerVersion,
  MarketObservation,
  MarketSummary,
  MutationHeader,
  Order,
  OrderOrigin,
  ReplaceOrder,
  SubmitOrder,
  SubmitMarketOrder,
  TimeInForce,
  Trade,
} from "../domain/models";
import { sha256 } from "./canonical";
import { clone, IdempotencyStore } from "./idempotency";
import { DeterministicOrderBookMatcher, type FinancialMarketMatcher } from "./matching";
import type {
  FinancialMarketSnapshot,
  FinancialMarketStateStore,
  MaterialMarketState,
  PersistedMarketRun,
  PersistedSeal,
} from "./persistence";
import type { FinancialInitialStatePresetRegistry, MarketMakerRegistry } from "./persistence";
import {
  UnavailableMarketMakerExecutor,
  type MarketMakerExecutor,
  type MarketMakerValidation,
} from "./market-maker-executor";

interface SealedState {
  checkpoint: MarketCheckpoint;
  facts: MarketFacts;
  material: MaterialMarketState;
}

interface MarketRun {
  runId: string;
  symbol?: string;
  referencePrice: number;
  priceScale?: number;
  tickSizeUnits?: number;
  accounts: Map<string, Account>;
  orders: Map<string, Order>;
  trades: Trade[];
  sequence: number;
  publishedRound: number;
  marketMaker?: MarketMakerSelection;
  sealed: Map<number, SealedState>;
}

export interface FinancialMarketServiceOptions {
  stateStore?: FinancialMarketStateStore;
  matcher?: FinancialMarketMatcher;
  marketMakerExecutor?: MarketMakerExecutor;
}

const DEFAULT_MARKET_MAKER_LIMITS: MarketMakerLimits = { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 };

/**
 * The only owner of Financial Market balances, reserves, order lifecycle,
 * settlement and market facts. Matching is a stateless, rebuildable internal
 * dependency: no engine object is treated as durable state.
 */
export class FinancialMarketService {
  private readonly runs = new Map<string, MarketRun>();
  private readonly idempotency = new IdempotencyStore();
  private readonly stateStore: FinancialMarketStateStore | undefined;
  private readonly matcher: FinancialMarketMatcher;
  private readonly marketMakerExecutor: MarketMakerExecutor;
  private marketMakerRegistry: MarketMakerRegistry = { drafts: {}, versions: {}, tombstones: [] };
  private financialInitialStatePresetRegistry: FinancialInitialStatePresetRegistry = { drafts: {}, versions: {}, tombstones: [] };
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(options: FinancialMarketServiceOptions) {
    this.stateStore = options.stateStore;
    this.matcher = options.matcher ?? new DeterministicOrderBookMatcher();
    this.marketMakerExecutor = options.marketMakerExecutor ?? new UnavailableMarketMakerExecutor();
  }

  static async create(options: FinancialMarketServiceOptions = {}): Promise<FinancialMarketService> {
    const service = new FinancialMarketService(options);
    const snapshot = await options.stateStore?.load();
    if (snapshot !== undefined) service.restore(snapshot);
    return service;
  }

  listFinancialInitialStatePresets(includeDeleted = false): { drafts: FinancialInitialStatePresetDraft[]; versions: FinancialInitialStatePresetVersion[]; tombstones?: AssetTombstone[] } { const tombstones = this.financialInitialStatePresetRegistry.tombstones ?? []; return { drafts: Object.values(this.financialInitialStatePresetRegistry.drafts).filter((item) => includeDeleted || !isDeleted(tombstones, "draft", item.presetId)).sort((a, b) => a.name.localeCompare(b.name)).map(clone), versions: Object.values(this.financialInitialStatePresetRegistry.versions).filter((item) => includeDeleted || !isDeleted(tombstones, "version", item.versionRef)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(clone), ...(includeDeleted ? { tombstones: clone(tombstones) } : {}) }; }
  getFinancialInitialStatePresetDraft(presetId: string, includeDeleted = false): FinancialInitialStatePresetDraft { const value = this.financialInitialStatePresetRegistry.drafts[presetId]; if (!value || (!includeDeleted && isDeleted(this.financialInitialStatePresetRegistry.tombstones ?? [], "draft", presetId))) throw notFound("Financial Initial State Preset draft does not exist"); return clone(value); }
  getFinancialInitialStatePresetVersion(versionRef: string, includeDeleted = false): FinancialInitialStatePresetVersion { const value = this.financialInitialStatePresetRegistry.versions[versionRef]; if (!value || (!includeDeleted && isDeleted(this.financialInitialStatePresetRegistry.tombstones ?? [], "version", versionRef))) throw notFound("Financial Initial State Preset version does not exist"); return clone(value); }
  async saveFinancialInitialStatePresetDraft(input: {
    presetId?: string;
    expectedRevision?: number;
    name: string;
    definition?: FinancialInitialStatePresetDefinition;
    cash?: number;
    positions?: Record<string, number>;
  }): Promise<FinancialInitialStatePresetDraft> {
    if (!input.name.trim()) throw invalid("Financial Initial State Preset name must not be empty", "name");
    const definition = financialInitialStatePresetDefinitionSchema.parse(
      input.definition ?? { mode: "fixed", cash: input.cash, positions: input.positions ?? {} },
    );
    if (definition.mode === "population_relative") {
      for (const sourceVersionRef of definition.sourcePresetVersionRefs) {
        this.getFinancialInitialStatePresetVersion(sourceVersionRef);
      }
    }
    return this.serializedMutation(async () => {
      const presetId = input.presetId ?? `financial-preset:${randomUUID()}`;
      if (isDeleted(this.financialInitialStatePresetRegistry.tombstones ?? [], "draft", presetId)) throw precondition("deleted Financial Initial State Preset draft IDs cannot be reused");
      const existing = this.financialInitialStatePresetRegistry.drafts[presetId];
      if (existing && existing.revision !== input.expectedRevision) throw precondition("Financial Initial State Preset draft has changed; reload before saving");
      if (!existing && input.expectedRevision !== undefined) throw notFound("Financial Initial State Preset draft does not exist");
      const draft: FinancialInitialStatePresetDraft = {
        presetId,
        name: input.name.trim(),
        ...clone(definition),
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      this.financialInitialStatePresetRegistry.drafts[presetId] = draft;
      await this.persist();
      return clone(draft);
    });
  }

  async publishFinancialInitialStatePreset(input: { presetId: string; expectedRevision: number }): Promise<FinancialInitialStatePresetVersion> {
    const draft = this.getFinancialInitialStatePresetDraft(input.presetId);
    if (draft.revision !== input.expectedRevision) throw precondition("Financial Initial State Preset draft has changed; reload before publishing");
    const { presetId, name, revision, updatedAt: _updatedAt, ...definition } = draft;
    const parsed = financialInitialStatePresetDefinitionSchema.parse(definition);
    if (parsed.mode === "population_relative") {
      for (const sourceVersionRef of parsed.sourcePresetVersionRefs) {
        this.getFinancialInitialStatePresetVersion(sourceVersionRef);
      }
    }
    const artifactDigest = sha256Digest(parsed);
    const existing = Object.values(this.financialInitialStatePresetRegistry.versions).find((item) => item.artifactDigest === artifactDigest);
    if (existing) {
      if (isDeleted(this.financialInitialStatePresetRegistry.tombstones ?? [], "version", existing.versionRef)) throw precondition("identical content belongs to a deleted Financial Initial State Preset version");
      return clone(existing);
    }
    const version: FinancialInitialStatePresetVersion = {
      presetId,
      name,
      ...clone(parsed),
      versionRef: `financial-preset:${presetId}:${artifactDigest.slice(0, 16)}`,
      artifactDigest,
      publishedAt: new Date().toISOString(),
      draftRevision: revision,
    };
    return this.serializedMutation(async () => {
      this.financialInitialStatePresetRegistry.versions[version.versionRef] = version;
      await this.persist();
      return clone(version);
    });
  }

  deleteFinancialInitialStatePresetDraft(input: { presetId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteAsset("financial-preset", "draft", input.presetId, input.idempotencyKey, input.expectedRevision, this.financialInitialStatePresetRegistry, this.financialInitialStatePresetRegistry.drafts[input.presetId]); }
  deleteFinancialInitialStatePresetVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteAsset("financial-preset", "version", input.versionRef, input.idempotencyKey, undefined, this.financialInitialStatePresetRegistry, this.financialInitialStatePresetRegistry.versions[input.versionRef]); }

  resolveFinancialInitialStatePreset(input: {
    versionRef: string;
    seed: string;
    subjectId: string;
    referencePrices: Record<string, number>;
    population: readonly { initialStatePresetVersionRef: string; cash: number; positions: Record<string, number> }[];
  }): { cash: number; positions: Record<string, number> } {
    const preset = this.getFinancialInitialStatePresetVersion(input.versionRef);
    if (preset.mode === "fixed") return { cash: preset.cash, positions: clone(preset.positions) };
    if (preset.mode === "deterministic_issuance") {
      const totalWeight = preset.buckets.reduce((total, bucket) => total + bucket.weight, 0);
      const sample = Number.parseInt(
        sha256({ seed: input.seed, subjectId: input.subjectId, seedSalt: preset.seedSalt }).slice(0, 13),
        16,
      ) / 0x10000000000000;
      let cursor = sample * totalWeight;
      const bucket = preset.buckets.find((candidate) => {
        cursor -= candidate.weight;
        return cursor <= 0;
      }) ?? preset.buckets.at(-1)!;
      const spend = Math.floor(preset.cash * bucket.spendCashFraction);
      return { cash: preset.cash - spend, positions: { [preset.symbol]: Math.floor(spend / preset.issuePrice) } };
    }
    const price = input.referencePrices[preset.symbol];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw invalid(`reference price is required for ${preset.symbol}`, "referencePrices");
    const referencePrice = price;
    for (const sourceVersionRef of preset.sourcePresetVersionRefs) {
      this.getFinancialInitialStatePresetVersion(sourceVersionRef);
    }
    const sources = new Set(preset.sourcePresetVersionRefs);
    const sourceWealth = input.population
      .filter((member) => sources.has(member.initialStatePresetVersionRef))
      .reduce((total, member) => total + member.cash + Object.entries(member.positions)
        .reduce((value, [symbol, quantity]) => value + quantity * (input.referencePrices[symbol] ?? 0), 0), 0);
    const wealth = Math.floor(sourceWealth * preset.wealthFraction);
    const position = Math.floor((wealth * preset.targetAssetValueFraction) / referencePrice);
    return { cash: wealth - position * referencePrice, positions: { [preset.symbol]: position } };
  }

  validateSection(section: FinancialMarketSection): void {
    requireSafePositive(section.initialReferencePrice, "initialReferencePrice");
    const priceScale = section.priceScale ?? 1;
    const tickSizeUnits = section.tickSizeUnits ?? 1;
    requireSafePositive(priceScale, "priceScale");
    requireSafePositive(tickSizeUnits, "tickSizeUnits");
    if (section.initialReferencePrice % tickSizeUnits !== 0) throw invalid("initialReferencePrice is not aligned to tickSize", "initialReferencePrice");
    if (section.accounts.length === 0) throw invalid("Financial Market requires accounts", "accounts");
    const ids = new Set<string>();
    for (const account of section.accounts) {
      if (!account.accountId.trim()) throw invalid("accountId must not be empty", "accounts.accountId");
      if (ids.has(account.accountId)) throw invalid("account IDs must be unique", "accounts.accountId");
      ids.add(account.accountId);
      requireSafeNonNegative(account.initialCash, "accounts.initialCash");
      requireSafeNonNegative(account.initialPosition, "accounts.initialPosition");
    }
    if (section.marketMaker !== undefined) this.validateMarketMakerSelection(section.marketMaker, ids);
  }

  /** Browser-safe index; source is only returned by the explicit draft/version getters. */
  listMarketMakers(includeDeleted = false): { drafts: MarketMakerDraft[]; versions: MarketMakerVersion[]; tombstones?: AssetTombstone[] } {
    const tombstones = this.marketMakerRegistry.tombstones ?? [];
    return {
      drafts: Object.values(this.marketMakerRegistry.drafts)
        .filter((item) => includeDeleted || !isDeleted(tombstones, "draft", item.algorithmId))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(clone),
      versions: Object.values(this.marketMakerRegistry.versions)
        .filter((item) => includeDeleted || !isDeleted(tombstones, "version", item.versionRef))
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
        .map(clone),
      ...(includeDeleted ? { tombstones: clone(tombstones) } : {}),
    };
  }

  getMarketMakerDraft(algorithmId: string, includeDeleted = false): MarketMakerDraft {
    if (!includeDeleted && isDeleted(this.marketMakerRegistry.tombstones ?? [], "draft", algorithmId)) throw notFound("market maker draft does not exist");
    return clone(this.requireMarketMakerDraft(algorithmId));
  }

  getMarketMakerVersion(versionRef: string, includeDeleted = false): MarketMakerVersion {
    if (!includeDeleted && isDeleted(this.marketMakerRegistry.tombstones ?? [], "version", versionRef)) throw notFound("market maker version does not exist");
    return clone(this.requirePublishedMarketMaker(versionRef));
  }

  async saveMarketMakerDraft(input: {
    algorithmId?: string;
    expectedRevision?: number;
    name: string;
    source: string;
    defaultConfig: Record<string, unknown>;
    configSchema?: Record<string, unknown>;
    dependencies?: string[];
    limits?: MarketMakerLimits;
  }): Promise<MarketMakerDraft> {
    requireText(input.name, "name");
    requireText(input.source, "source");
    if (!isPlainRecord(input.defaultConfig)) throw invalid("defaultConfig must be an object", "defaultConfig");
    if (input.configSchema !== undefined && !isPlainRecord(input.configSchema)) {
      throw invalid("configSchema must be an object", "configSchema");
    }
    const dependencies = normalizeDependencies(input.dependencies);
    const limits = normalizeMarketMakerLimits(input.limits);
    return this.serializedMutation(async () => {
      const before = this.snapshot();
      try {
        const algorithmId = input.algorithmId ?? `market-maker:${randomUUID()}`;
        if (isDeleted(this.marketMakerRegistry.tombstones ?? [], "draft", algorithmId)) throw precondition("deleted market maker draft IDs cannot be reused");
        const existing = this.marketMakerRegistry.drafts[algorithmId];
        if (existing !== undefined && input.expectedRevision !== existing.revision) {
          throw precondition("market maker draft has changed; reload before saving");
        }
        if (existing === undefined && input.expectedRevision !== undefined) {
          throw notFound("market maker draft does not exist");
        }
        const draft: MarketMakerDraft = {
          algorithmId,
          name: input.name.trim(),
          source: input.source,
          defaultConfig: clone(input.defaultConfig),
          configSchema: clone(input.configSchema ?? existing?.configSchema ?? {}),
          dependencies,
          limits,
          revision: (existing?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        this.marketMakerRegistry.drafts[algorithmId] = draft;
        await this.persist();
        return clone(draft);
      } catch (error) {
        this.restore(before);
        throw error;
      }
    });
  }

  async validateMarketMaker(input: {
    algorithmId: string;
    source?: string;
    dependencies?: string[];
    limits?: MarketMakerLimits;
  }): Promise<MarketMakerValidation> {
    const draft = this.requireMarketMakerDraft(input.algorithmId);
    return this.marketMakerExecutor.validate({
      source: input.source ?? draft.source,
      dependencies: normalizeDependencies(input.dependencies ?? draft.dependencies),
      limits: normalizeMarketMakerLimits(input.limits ?? draft.limits),
    });
  }

  async publishMarketMaker(input: { algorithmId: string; expectedRevision: number }): Promise<MarketMakerVersion> {
    const draft = this.requireMarketMakerDraft(input.algorithmId);
    if (draft.revision !== input.expectedRevision) {
      throw precondition("market maker draft has changed; reload before publishing");
    }
    const validation = await this.marketMakerExecutor.validate({
      source: draft.source,
      dependencies: draft.dependencies,
      limits: draft.limits,
    });
    if (!validation.valid) {
      throw invalid(`market maker validation failed: ${validation.errors.join("; ") || "unknown error"}`, "source");
    }
    const configSchema = validation.configSchema ?? draft.configSchema;
    const defaultConfig = validation.defaultConfig ?? draft.defaultConfig;
    validateMarketMakerConfig(configSchema, defaultConfig);
    const artifactDigest = sha256({
      source: draft.source,
      configSchema,
      defaultConfig,
      dependencies: draft.dependencies,
      limits: draft.limits,
    });
    return this.serializedMutation(async () => {
      const before = this.snapshot();
      try {
        const existing = Object.values(this.marketMakerRegistry.versions)
          .find((version) => version.artifactDigest === artifactDigest);
        if (existing !== undefined) {
          if (isDeleted(this.marketMakerRegistry.tombstones ?? [], "version", existing.versionRef)) throw precondition("identical content belongs to a deleted market maker version");
          return clone(existing);
        }
        const version: MarketMakerVersion = {
          algorithmId: draft.algorithmId,
          name: draft.name,
          source: draft.source,
          defaultConfig: clone(defaultConfig),
          configSchema: clone(configSchema),
          dependencies: [...draft.dependencies],
          limits: clone(draft.limits),
          versionRef: `market-maker:${draft.algorithmId}:${artifactDigest.slice(0, 16)}`,
          artifactDigest,
          publishedAt: new Date().toISOString(),
          draftRevision: draft.revision,
        };
        this.marketMakerRegistry.versions[version.versionRef] = version;
        await this.persist();
        return clone(version);
      } catch (error) {
        this.restore(before);
        throw error;
      }
    });
  }

  deleteMarketMakerDraft(input: { algorithmId: string; expectedRevision: number; idempotencyKey: string }) { return this.deleteAsset("market-maker", "draft", input.algorithmId, input.idempotencyKey, input.expectedRevision, this.marketMakerRegistry, this.marketMakerRegistry.drafts[input.algorithmId]); }
  deleteMarketMakerVersion(input: { versionRef: string; idempotencyKey: string }) { return this.deleteAsset("market-maker", "version", input.versionRef, input.idempotencyKey, undefined, this.marketMakerRegistry, this.marketMakerRegistry.versions[input.versionRef]); }

  /**
   * Executes an already-published class. The caller owns the short-lived
   * dedicated history capability and persists the normalized result.
   */
  async executeMarketMaker(input: {
    selection: MarketMakerSelection;
    roundId: number;
    seed: string;
    financialHistory: { endpoint: string; capability: string };
    priceUnits?: PriceUnits;
  }): Promise<{ orders: MarketMakerOrderIntent[] }> {
    const version = this.requirePublishedMarketMaker(input.selection.versionRef);
    const config = effectiveMarketMakerConfig(version, input.selection.config);
    try {
      const result = await this.marketMakerExecutor.execute({
        source: version.source,
        config,
        seed: input.seed,
        roundId: input.roundId,
        timing: input.selection.timing,
        financialHistory: clone(input.financialHistory),
        limits: clone(version.limits),
        dependencies: [...version.dependencies],
      });
      const units = input.priceUnits ?? { priceScale: 1, tickSizeUnits: 1 };
      const orders = result.orders.map((order) => ({
        ...order,
        limitPrice: priceToUnits(order.limitPrice, units, "marketMaker.orders.limitPrice"),
      }));
      for (const order of orders) validateMarketMakerIntent(order);
      return { orders: orders.map(clone) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown runner failure";
      throw invalid(`market maker execution failed: ${message.slice(0, 1_000)}`, "marketMaker");
    }
  }

  async initialize(
    runId: string,
    section: FinancialMarketSection,
    mutation: MutationHeader,
  ): Promise<MarketCheckpoint> {
    return this.serializedMutation(async () => {
      if (!runId.trim()) throw invalid("runId must not be empty", "runId");
      this.validateSection(section);
      this.validateMutation(mutation, true);
      return this.executeAtomically(mutation, async () => {
        const existing = this.runs.get(runId);
        if (existing !== undefined) return this.sealedCheckpoint(existing, 0);
        const accounts = new Map(
          section.accounts.map((seed) => [seed.accountId, accountFromSeed(seed)]),
        );
        const run: MarketRun = {
          runId,
          ...(section.symbol === undefined ? {} : { symbol: section.symbol }),
          referencePrice: section.initialReferencePrice,
          ...(section.priceScale === undefined ? {} : { priceScale: section.priceScale }),
          ...(section.tickSizeUnits === undefined ? {} : { tickSizeUnits: section.tickSizeUnits }),
          accounts,
          orders: new Map(),
          trades: [],
          sequence: 0,
          publishedRound: 0,
          ...(section.marketMaker === undefined ? {} : { marketMaker: clone(section.marketMaker) }),
          sealed: new Map(),
        };
        this.runs.set(runId, run);
        const checkpoint = this.checkpoint(run, 0);
        run.sealed.set(0, this.captureSeal(run, checkpoint, 0));
        return checkpoint;
      });
    });
  }

  async openRound(runId: string, roundId: number, mutation: MutationHeader): Promise<MarketSummary> {
    return this.withRunMutation(runId, roundId, mutation, async (run) => {
      this.requireRoundInProgress(run, roundId);
      return this.summaryFor(run, roundId);
    });
  }

  getObservations(
    runId: string,
    roundId: number,
    committedCheckpointRef: string,
    accountIds: readonly string[],
  ): MarketObservation[] {
    const run = this.requireRun(runId);
    const committed = this.sealedCheckpoint(run, run.publishedRound);
    if (committed.ref !== committedCheckpointRef) {
      throw precondition("Market observation requires the current committed checkpoint");
    }
    const summary = this.summaryFor(run, roundId);
    return accountIds.map((accountId) => {
      const account = this.requireAccount(run, accountId);
      return {
        accountId,
        lastTradePrice: summary.lastTradePrice,
        bestBid: summary.bestBid,
        bestAsk: summary.bestAsk,
        availableCash: account.cash - account.reservedCash,
        availablePosition: account.position - account.reservedPosition,
      };
    });
  }

  /**
   * Frozen market view for Agent Execution. It reads the material state saved
   * with a published seal, so opening the next round cannot leak maker quotes,
   * reserves, or fills into the baseline request.
   */
  getCommittedObservation(
    runId: string,
    committedCheckpointRef: string,
  ): { accounts: Array<{ accountId: string; cash: number; positions: Record<string, number> }>; quotes: Array<{ symbol: string; bid?: number; ask?: number; last?: number }> } {
    const run = this.requireRun(runId);
    const sealed = [...run.sealed.values()].find((item) => item.checkpoint.ref === committedCheckpointRef);
    if (sealed === undefined || sealed.checkpoint.roundId > run.publishedRound) {
      throw precondition("Financial observation requires a published checkpoint");
    }
    if (sealed.material === undefined) {
      throw precondition("Financial observation requires the current committed checkpoint");
    }
    if (run.symbol === undefined) {
      throw precondition("Financial observation requires a configured instrument symbol");
    }
    const material = sealed.material;
    const priceScale = unitsForSnapshot(material).priceScale;
    const openOrders = material.orders.filter((order) => order.status === "open");
    const bids = openOrders.filter((order) => order.side === "buy" && order.orderType !== "market").map(limitPrice);
    const asks = openOrders.filter((order) => order.side === "sell" && order.orderType !== "market").map(limitPrice);
    const last = material.trades.at(-1)?.price ?? material.referencePrice;
    return {
      accounts: material.accounts.map((account) => ({
        accountId: account.accountId,
        cash: unitsToDecimal(account.cash, priceScale),
        positions: { [run.symbol!]: account.position },
      })),
      quotes: [{
        symbol: run.symbol,
        ...(bids.length === 0 ? {} : { bid: unitsToDecimal(Math.max(...bids), priceScale) }),
        ...(asks.length === 0 ? {} : { ask: unitsToDecimal(Math.min(...asks), priceScale) }),
        last: unitsToDecimal(last, priceScale),
      }],
    };
  }

  /**
   * Returns the complete immutable material captured at a published checkpoint.
   * Revision resources deliberately use this payload instead of this service's
   * mutable in-progress run, so a later legacy `openRound` cannot leak into a
   * pinned Context revision.
   */
  getFullSnapshot(runId: string, checkpointRef: string): MaterialMarketState {
    const run = this.requireRun(runId);
    const sealed = [...run.sealed.values()].find((item) => item.checkpoint.ref === checkpointRef);
    if (sealed === undefined || sealed.checkpoint.roundId > run.publishedRound) {
      throw precondition("Financial revision requires a published checkpoint");
    }
    if (sealed.material === undefined) {
      throw precondition("Financial revision snapshot is not resident");
    }
    return clone(sealed.material);
  }

  /**
   * Rebuilds a candidate round from a full revision and actions in durable
   * stream order.  It never mutates the live run or persists data: callers use
   * it to materialize a private worktree and then store an immutable revision.
   */
  materializeRoundFromSnapshot(input: {
    runId: string;
    roundId: number;
    base: MaterialMarketState;
    actions: readonly MarketAction[];
    /** The revision layer executes code and persists this result before passing it here. */
    openingMarketMakerOrders?: readonly MarketMakerOrderIntent[];
    settlementMarketMakerOrders?: readonly MarketMakerOrderIntent[];
  }): { material: MaterialMarketState; summary: MarketSummary; trades: Trade[] } {
    requireRoundId(input.roundId);
    const run = this.runFromMaterial(input.runId, clone(input.base));
    if (input.roundId !== run.publishedRound + 1) {
      throw precondition("Financial candidate must advance its parent revision by one round");
    }
    if (input.openingMarketMakerOrders !== undefined) {
      this.replaceMarketMakerOrders(run, input.roundId, input.openingMarketMakerOrders, "opening");
    }
    const tradeStart = run.trades.length;
    for (const action of input.actions) {
      const submitted: string[] = [];
      if (action.type === "submitOrder") {
        if (this.submit(run, action)) submitted.push(action.actionId);
      } else if (action.type === "submitMarketOrder") {
        this.submitMarket(run, input.roundId, action);
      } else if (action.type === "replaceOrder") {
        if (this.replace(run, action)) submitted.push(action.replacementOrderId);
      } else {
        this.cancel(run, action);
      }
      this.match(run, input.roundId);
      for (const orderId of submitted) {
        const order = run.orders.get(orderId);
        if (order !== undefined && order.status === "open" && order.timeInForce !== "gtc") {
          this.release(run, order);
          order.status = "cancelled";
        }
      }
    }
    for (const order of run.orders.values()) {
      if (order.status === "open" && order.expiresAtRound !== undefined && order.expiresAtRound <= input.roundId) {
        this.release(run, order);
        order.status = "expired";
      }
    }
    if (input.settlementMarketMakerOrders !== undefined) {
      this.replaceMarketMakerOrders(run, input.roundId, input.settlementMarketMakerOrders, "settlement");
    }
    // A candidate is the next commit on this Context's branch. Its material
    // therefore carries the new round as its parent boundary even though the
    // Experiment manifest has not moved global HEAD yet.
    run.publishedRound = input.roundId;
    return {
      material: this.material(run),
      summary: this.summaryFor(run, input.roundId),
      trades: clone(run.trades.slice(tradeStart)),
    };
  }

  /**
   * Opt-in incremental counterpart to materializeRoundFromSnapshot. The
   * default batch path above remains byte-for-byte compatible. Here each fill
   * is settled before an optional Market Maker callback observes the new
   * candidate state and atomically replaces only its own quotes.
   */
  async materializeRoundIncrementallyFromSnapshot(input: {
    runId: string;
    roundId: number;
    base: MaterialMarketState;
    actions: readonly MarketAction[];
    openingMarketMakerOrders?: readonly MarketMakerOrderIntent[];
    settlementMarketMakerOrders?: readonly MarketMakerOrderIntent[];
    afterTrade?: (input: {
      trade: Trade;
      material: MaterialMarketState;
      requoteIndex: number;
      actionIndex: number;
    }) => Promise<readonly MarketMakerOrderIntent[] | undefined>;
  }): Promise<{ material: MaterialMarketState; summary: MarketSummary; trades: Trade[] }> {
    requireRoundId(input.roundId);
    const run = this.runFromMaterial(input.runId, clone(input.base));
    if (input.roundId !== run.publishedRound + 1) {
      throw precondition("Financial candidate must advance its parent revision by one round");
    }
    if (input.openingMarketMakerOrders !== undefined) {
      this.replaceMarketMakerOrders(run, input.roundId, input.openingMarketMakerOrders, "opening", false);
    }
    const tradeStart = run.trades.length;
    const selection = run.marketMaker;
    const requoteEnabled = selection?.requotePolicy === "after_each_trade" && input.afterTrade !== undefined;
    const maxRequotes = selection?.maxRequotesPerIntent ?? 1_000;
    const drain = async (actionIndex: number): Promise<void> => {
      let requoteIndex = 0;
      for (;;) {
        const matched = this.matcher.matchNext(this.openOrders(run));
        if (matched === undefined) return;
        this.applyMatch(run, input.roundId, matched);
        if (!requoteEnabled || requoteIndex >= maxRequotes) continue;
        const trade = run.trades.at(-1)!;
        const orders = await input.afterTrade!({
          trade: clone(trade),
          material: this.material(run),
          requoteIndex,
          actionIndex,
        });
        requoteIndex += 1;
        if (orders !== undefined) {
          this.replaceMarketMakerOrders(
            run,
            input.roundId,
            orders,
            selection!.timing,
            false,
            `after-trade:${trade.tradeId}`,
          );
        }
      }
    };
    await drain(-1);
    for (const [actionIndex, action] of input.actions.entries()) {
      const submitted: string[] = [];
      if (action.type === "submitOrder") {
        if (this.submit(run, action)) submitted.push(action.actionId);
      } else if (action.type === "submitMarketOrder") {
        await this.submitMarketIncrementally(run, input.roundId, action, actionIndex, async (trade, requoteIndex) => {
          if (!requoteEnabled || requoteIndex >= maxRequotes) return;
          const orders = await input.afterTrade!({
            trade: clone(trade),
            material: this.material(run),
            requoteIndex,
            actionIndex,
          });
          if (orders !== undefined) {
            this.replaceMarketMakerOrders(
              run,
              input.roundId,
              orders,
              selection!.timing,
              false,
              `after-trade:${trade.tradeId}`,
            );
          }
        });
      } else if (action.type === "replaceOrder") {
        if (this.replace(run, action)) submitted.push(action.replacementOrderId);
      } else {
        this.cancel(run, action);
      }
      await drain(actionIndex);
      for (const orderId of submitted) {
        const order = run.orders.get(orderId);
        if (order !== undefined && order.status === "open" && order.timeInForce !== "gtc") {
          this.release(run, order);
          order.status = "cancelled";
        }
      }
    }
    for (const order of run.orders.values()) {
      if (order.status === "open" && order.expiresAtRound !== undefined && order.expiresAtRound <= input.roundId) {
        this.release(run, order);
        order.status = "expired";
      }
    }
    if (input.settlementMarketMakerOrders !== undefined) {
      this.replaceMarketMakerOrders(run, input.roundId, input.settlementMarketMakerOrders, "settlement", false);
      await drain(input.actions.length);
    }
    run.publishedRound = input.roundId;
    return {
      material: this.material(run),
      summary: this.summaryFor(run, input.roundId),
      trades: clone(run.trades.slice(tradeStart)),
    };
  }

  async apply(
    runId: string,
    roundId: number,
    actions: readonly MarketAction[],
    mutation: MutationHeader,
  ): Promise<{ trades: Trade[]; summary: MarketSummary }> {
    return this.withRunMutation(runId, roundId, mutation, async (run) => {
      this.requireRoundInProgress(run, roundId);
      const tradeStart = run.trades.length;
      const submitted: string[] = [];
      for (const action of actions) {
        if (action.type === "submitOrder") {
          if (this.submit(run, action)) submitted.push(action.actionId);
        } else if (action.type === "submitMarketOrder") {
          this.submitMarket(run, roundId, action);
        } else if (action.type === "replaceOrder") {
          if (this.replace(run, action)) submitted.push(action.replacementOrderId);
        } else {
          this.cancel(run, action);
        }
      }
      this.match(run, roundId);
      for (const orderId of submitted) {
        const order = run.orders.get(orderId);
        if (order !== undefined && order.status === "open" && order.timeInForce !== "gtc") {
          this.release(run, order);
          order.status = "cancelled";
        }
      }
      return { trades: clone(run.trades.slice(tradeStart)), summary: this.summaryFor(run, roundId) };
    });
  }

  async closeRound(runId: string, roundId: number, mutation: MutationHeader): Promise<MarketSummary> {
    return this.withRunMutation(runId, roundId, mutation, async (run) => {
      this.requireRoundInProgress(run, roundId);
      for (const order of run.orders.values()) {
        if (order.status === "open" && order.expiresAtRound !== undefined && order.expiresAtRound <= roundId) {
          this.release(run, order);
          order.status = "expired";
        }
      }
      return this.summaryFor(run, roundId);
    });
  }

  async seal(runId: string, roundId: number, mutation: MutationHeader): Promise<MarketCheckpoint> {
    return this.withRunMutation(runId, roundId, mutation, async (run) => {
      this.requireRoundInProgress(run, roundId);
      const checkpoint = this.checkpoint(run, roundId);
      run.sealed.set(roundId, this.captureSeal(run, checkpoint, roundId));
      return checkpoint;
    });
  }

  async publish(
    runId: string,
    roundId: number,
    checkpointRef: string,
    mutation: MutationHeader,
  ): Promise<MarketCheckpoint> {
    return this.withRunMutation(runId, roundId, mutation, async (run) => {
      const sealed = run.sealed.get(roundId);
      if (sealed === undefined || sealed.checkpoint.ref !== checkpointRef) {
        throw precondition("only the sealed Market checkpoint may be published");
      }
      if (roundId !== run.publishedRound + 1) {
        throw precondition("Market rounds must publish sequentially");
      }
      run.publishedRound = roundId;
      return clone(sealed.checkpoint);
    });
  }

  async fork(
    sourceRunId: string,
    targetRunId: string,
    checkpointRef: string,
    mutation: MutationHeader,
  ): Promise<MarketCheckpoint> {
    return this.serializedMutation(async () => {
      const source = this.requireRun(sourceRunId);
      if (!targetRunId.trim()) throw invalid("targetRunId must not be empty", "targetRunId");
      this.validateMutation(mutation, false);
      this.requireExpectedCheckpoint(source, mutation);
      return this.executeAtomically(mutation, async () => {
        let sourceSeal = [...source.sealed.values()].find((item) => item.checkpoint.ref === checkpointRef);
        if (sourceSeal === undefined || sourceSeal.checkpoint.roundId > source.publishedRound) {
          throw precondition("fork source must be a published Market checkpoint");
        }
        if (sourceSeal.material === undefined) {
          sourceSeal = await this.stateStore?.loadSeal(sourceRunId, sourceSeal.checkpoint.roundId);
          if (sourceSeal === undefined) throw precondition("fork source snapshot is unavailable");
        }
        const existing = this.runs.get(targetRunId);
        if (existing !== undefined) return this.sealedCheckpoint(existing, sourceSeal.checkpoint.roundId);
        const target = this.runFromMaterial(targetRunId, sourceSeal.material);
        // A seal captures state before its later publish operation. The fork
        // source is known to be published, therefore the target's initial
        // committed boundary is the source checkpoint rather than the stale
        // pre-publish counter embedded in the material snapshot.
        target.publishedRound = sourceSeal.checkpoint.roundId;
        const checkpoint = this.checkpoint(target, sourceSeal.checkpoint.roundId);
        const sourceFacts = clone(sourceSeal.facts);
        target.sealed.set(sourceSeal.checkpoint.roundId, {
          checkpoint,
          facts: { ...sourceFacts, checkpoint: clone(checkpoint) },
          material: this.material(target),
        });
        this.runs.set(targetRunId, target);
        return checkpoint;
      });
    });
  }

  getCommittedFacts(runId: string, roundId: number, checkpointRef: string): MarketFacts {
    const run = this.requireRun(runId);
    const sealed = run.sealed.get(roundId);
    if (
      sealed === undefined ||
      sealed.checkpoint.ref !== checkpointRef ||
      roundId > run.publishedRound
    ) {
      throw precondition("only committed Market facts are queryable");
    }
    const scale = unitsForSnapshot(sealed.material).priceScale;
    const facts = clone(sealed.facts);
    return {
      ...facts,
      trades: facts.trades.map((trade) => ({ ...trade, price: unitsToDecimal(trade.price, scale) })),
      summary: {
        ...facts.summary,
        lastTradePrice: unitsToDecimal(facts.summary.lastTradePrice, scale),
        bestBid: unitsToDecimal(facts.summary.bestBid, scale),
        bestAsk: unitsToDecimal(facts.summary.bestAsk, scale),
      },
    };
  }

  getAccount(runId: string, accountId: string): Account {
    return clone(this.requireAccount(this.requireRun(runId), accountId));
  }

  getSealedCheckpoint(runId: string, roundId: number): MarketCheckpoint {
    return clone(this.sealedCheckpoint(this.requireRun(runId), roundId));
  }

  getSummary(runId: string, roundId: number): MarketSummary {
    return this.summaryFor(this.requireRun(runId), roundId);
  }

  /** Used only to mark a transport receipt; replay semantics remain enforced here. */
  hasSuccessfulMutation(mutation: MutationHeader): boolean {
    return this.idempotency.has(mutation.transitionId, mutation.stepId);
  }

  private async withRunMutation<Result>(
    runId: string,
    roundId: number,
    mutation: MutationHeader,
    operation: (run: MarketRun) => Promise<Result> | Result,
  ): Promise<Result> {
    return this.serializedMutation(async () => {
      const run = this.requireRun(runId);
      requireRoundId(roundId);
      this.validateMutation(mutation, false);
      this.requireExpectedCheckpoint(run, mutation);
      return this.executeAtomically(mutation, () => operation(run));
    });
  }

  private async executeAtomically<Result>(
    mutation: MutationHeader,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    const inMemoryRollback = this.stateStore === undefined ? this.snapshot() : undefined;
    try {
      const result = await this.idempotency.execute(
        mutation.transitionId,
        mutation.stepId,
        mutation.payloadDigest,
        operation,
      );
      await this.persist();
      return result;
    } catch (error) {
      const durable = await this.stateStore?.load();
      if (durable !== undefined) this.restore(durable);
      else if (inMemoryRollback !== undefined) this.restore(inMemoryRollback);
      throw error;
    }
  }

  private async deleteAsset(
    assetKind: string,
    target: AssetDeleteTarget,
    assetId: string,
    idempotencyKey: string,
    expectedRevision: number | undefined,
    registry: { tombstones?: AssetTombstone[] },
    record: unknown,
  ): Promise<AssetDeletionResult> {
    return this.serializedMutation(async () => {
      const existing = (registry.tombstones ?? []).find((item) => item.target === target && item.assetId === assetId);
      if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === idempotencyKey, tombstone: clone(existing) };
      if (!record) throw notFound(`${assetKind} ${target} does not exist`);
      if (target === "draft" && (record as { revision?: unknown }).revision !== expectedRevision) {
        throw precondition(`${assetKind} draft has changed; reload before deleting`);
      }
      const tombstone: AssetTombstone = {
        assetKind,
        assetId,
        target,
        deletedAt: new Date().toISOString(),
        idempotencyKey,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };
      (registry.tombstones ??= []).push(tombstone);
      await this.persist();
      return { status: "deleted", replayed: false, tombstone: clone(tombstone) };
    });
  }

  private async serializedMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private validateMutation(mutation: MutationHeader, initialization: boolean): void {
    if (!mutation.transitionId.trim() || !mutation.stepId.trim()) {
      throw invalid("mutation requires transitionId and stepId", "mutation");
    }
    if (!mutation.payloadDigest.trim()) {
      throw invalid("mutation requires payloadDigest", "mutation.payloadDigest");
    }
    if (initialization ? mutation.expectedCheckpointRef !== "" : !mutation.expectedCheckpointRef.trim()) {
      throw invalid(
        initialization
          ? "initialization requires an empty expectedCheckpointRef"
          : "mutation requires expectedCheckpointRef",
        "mutation.expectedCheckpointRef",
      );
    }
  }

  private requireExpectedCheckpoint(run: MarketRun, mutation: MutationHeader): void {
    if (this.idempotency.has(mutation.transitionId, mutation.stepId)) return;
    const committed = this.sealedCheckpoint(run, run.publishedRound);
    if (mutation.expectedCheckpointRef !== committed.ref) {
      throw precondition("expectedCheckpointRef is not this run's committed checkpoint");
    }
  }

  private validateMarketMakerSelection(selection: MarketMakerSelection, accountIds: Set<string>): void {
    requireText(selection.versionRef, "marketMaker.versionRef");
    requireText(selection.accountId, "marketMaker.accountId");
    if (!accountIds.has(selection.accountId)) {
      throw invalid("marketMaker accountId must name an account", "marketMaker.accountId");
    }
    if (selection.timing !== "opening" && selection.timing !== "settlement") {
      throw invalid("marketMaker timing must be opening or settlement", "marketMaker.timing");
    }
    if (selection.matchingPolicy !== undefined && selection.matchingPolicy !== "batch" && selection.matchingPolicy !== "incremental") {
      throw invalid("marketMaker matchingPolicy must be batch or incremental", "marketMaker.matchingPolicy");
    }
    if (selection.requotePolicy !== undefined && selection.requotePolicy !== "none" && selection.requotePolicy !== "after_each_trade") {
      throw invalid("marketMaker requotePolicy must be none or after_each_trade", "marketMaker.requotePolicy");
    }
    if (
      selection.maxRequotesPerIntent !== undefined
      && (!Number.isSafeInteger(selection.maxRequotesPerIntent) || selection.maxRequotesPerIntent < 1 || selection.maxRequotesPerIntent > 100_000)
    ) {
      throw invalid("marketMaker maxRequotesPerIntent must be a positive safe integer at most 100000", "marketMaker.maxRequotesPerIntent");
    }
    if (selection.requotePolicy === "after_each_trade" && selection.matchingPolicy !== "incremental") {
      throw invalid("after_each_trade requoting requires incremental matching", "marketMaker.requotePolicy");
    }
    if (!isPlainRecord(selection.config)) throw invalid("marketMaker config must be an object", "marketMaker.config");
    const version = this.requirePublishedMarketMaker(selection.versionRef);
    if (isDeleted(this.marketMakerRegistry.tombstones ?? [], "version", version.versionRef)) throw invalid(`market maker version '${version.versionRef}' has been deleted`, "marketMaker.versionRef");
    effectiveMarketMakerConfig(version, selection.config);
  }

  private requireRoundInProgress(run: MarketRun, roundId: number): void {
    if (roundId !== run.publishedRound + 1) {
      throw precondition("Market round must be the next uncommitted round");
    }
    if (run.sealed.has(roundId)) throw precondition("sealed Market rounds are immutable");
  }

  private requireRun(runId: string): MarketRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw notFound(`unknown Financial Market run: ${runId}`);
    return run;
  }

  private requireAccount(run: MarketRun, accountId: string): Account {
    const account = run.accounts.get(accountId);
    if (account === undefined) throw invalid(`unknown account: ${accountId}`, "accountId");
    return account;
  }

  private sealedCheckpoint(run: MarketRun, roundId: number): MarketCheckpoint {
    const sealed = run.sealed.get(roundId);
    if (sealed === undefined) throw precondition(`Market round ${roundId} has not been sealed`);
    return sealed.checkpoint;
  }

  private submit(run: MarketRun, action: SubmitOrder, origin: OrderOrigin = "agent"): boolean {
    requireSafePositive(action.quantity, "actions.quantity");
    requireSafePositive(action.limitPrice, "actions.limitPrice");
    if (action.limitPrice % (run.tickSizeUnits ?? 1) !== 0) throw invalid("actions.limitPrice is not aligned to tickSize", "actions.limitPrice");
    if (!action.actionId.trim()) throw invalid("actionId must not be empty", "actions.actionId");
    if (action.expiresAtRound !== undefined) requireRoundId(action.expiresAtRound);
    if (run.orders.has(action.actionId)) return false;
    const timeInForce = action.timeInForce ?? "gtc";
    if (timeInForce === "fok" && !this.canFullyFill(run, action)) return false;
    const account = this.requireAccount(run, action.accountId);
    if (action.side === "buy") {
      const reserve = action.quantity * action.limitPrice;
      requireSafeNonNegative(reserve, "actions reserve");
      if (account.cash - account.reservedCash < reserve) throw invalid("insufficient available cash", "actions.quantity");
      account.reservedCash += reserve;
    } else {
      if (account.position - account.reservedPosition < action.quantity) {
        throw invalid("insufficient available position", "actions.quantity");
      }
      account.reservedPosition += action.quantity;
    }
    run.sequence += 1;
    run.orders.set(action.actionId, {
      orderId: action.actionId,
      accountId: action.accountId,
      side: action.side,
      orderType: "limit",
      quantity: action.quantity,
      remaining: action.quantity,
      limitPrice: action.limitPrice,
      createdSequence: run.sequence,
      ...(action.expiresAtRound === undefined ? {} : { expiresAtRound: action.expiresAtRound }),
      timeInForce,
      status: "open",
      origin,
    });
    return true;
  }

  private canFullyFill(run: MarketRun, action: SubmitOrder): boolean {
    const oppositeSide = action.side === "buy" ? "sell" : "buy";
    const executable = [...run.orders.values()]
      .filter(
        (order) =>
          order.status === "open" &&
          order.side === oppositeSide &&
          order.accountId !== action.accountId &&
          order.orderType !== "market" &&
          (action.side === "buy" ? limitPrice(order) <= action.limitPrice : limitPrice(order) >= action.limitPrice),
      )
      .sort(
        action.side === "buy"
          ? (left, right) => limitPrice(left) - limitPrice(right) || left.createdSequence - right.createdSequence
          : (left, right) => limitPrice(right) - limitPrice(left) || left.createdSequence - right.createdSequence,
      );
    return executable.reduce((total, order) => total + order.remaining, 0) >= action.quantity;
  }

  private replace(run: MarketRun, action: ReplaceOrder): boolean {
    const existing = run.orders.get(action.orderId);
    if (existing === undefined || existing.accountId !== action.accountId || existing.status !== "open" || existing.orderType === "market") {
      throw invalid("only an account's open limit order may be replaced", "actions.orderId");
    }
    if (run.orders.has(action.replacementOrderId)) return false;
    this.release(run, existing);
    existing.status = "replaced";
    existing.replacedByOrderId = action.replacementOrderId;
    const submitted = this.submit(run, {
      type: "submitOrder",
      actionId: action.replacementOrderId,
      accountId: action.accountId,
      side: action.side,
      quantity: action.quantity,
      limitPrice: action.limitPrice,
      ...(action.expiresAtRound === undefined ? {} : { expiresAtRound: action.expiresAtRound }),
      ...(action.timeInForce === undefined ? {} : { timeInForce: action.timeInForce }),
    });
    if (submitted) run.orders.get(action.replacementOrderId)!.replacesOrderId = existing.orderId;
    return submitted;
  }

  private submitMarket(run: MarketRun, roundId: number, action: SubmitMarketOrder): void {
    this.createMarketOrder(run, action);
    this.drainMarketOrder(run, roundId, action.actionId);
    this.finishMarketOrder(run, action);
  }

  private async submitMarketIncrementally(
    run: MarketRun,
    roundId: number,
    action: SubmitMarketOrder,
    _actionIndex: number,
    afterTrade: (trade: Trade, requoteIndex: number) => Promise<void>,
  ): Promise<void> {
    this.createMarketOrder(run, action);
    let requoteIndex = 0;
    while (this.matchMarketNext(run, roundId, action.actionId)) {
      await afterTrade(run.trades.at(-1)!, requoteIndex++);
    }
    this.finishMarketOrder(run, action);
  }

  private createMarketOrder(run: MarketRun, action: SubmitMarketOrder): void {
    requireSafePositive(action.quantity, "actions.quantity");
    if (!action.actionId.trim()) throw invalid("actionId must not be empty", "actions.actionId");
    if (run.orders.has(action.actionId)) return;
    const account = this.requireAccount(run, action.accountId);
    if (action.side === "sell") {
      if (account.position - account.reservedPosition < action.quantity) throw invalid("insufficient available position", "actions.quantity");
      account.reservedPosition += action.quantity;
    } else {
      const availableCash = account.cash - account.reservedCash;
      if (availableCash < 1) throw invalid("insufficient available cash", "actions.quantity");
      if (action.cashBudget !== undefined) {
        requireSafePositive(action.cashBudget, "actions.cashBudget");
        if (action.cashBudget > availableCash) throw invalid("cash budget exceeds available cash", "actions.cashBudget");
      }
    }
    run.sequence += 1;
    run.orders.set(action.actionId, {
      orderId: action.actionId,
      accountId: action.accountId,
      side: action.side,
      orderType: "market",
      quantity: action.quantity,
      remaining: action.quantity,
      ...(action.cashBudget === undefined ? {} : { cashBudget: action.cashBudget }),
      createdSequence: run.sequence,
      timeInForce: action.timeInForce,
      status: "open",
      origin: "agent",
    });
  }

  private drainMarketOrder(run: MarketRun, roundId: number, orderId: string): void {
    while (this.matchMarketNext(run, roundId, orderId)) {
      // A market order consumes only liquidity already resting at its arrival.
    }
  }

  private matchMarketNext(run: MarketRun, roundId: number, orderId: string): boolean {
    const market = run.orders.get(orderId);
    if (market === undefined || market.status !== "open" || market.remaining === 0) return false;
    const opposite = [...run.orders.values()]
      .filter((order) => order.status === "open" && order.orderType !== "market" && order.side !== market.side && order.accountId !== market.accountId)
      .sort(market.side === "buy"
        ? (left, right) => limitPrice(left) - limitPrice(right) || left.createdSequence - right.createdSequence
        : (left, right) => limitPrice(right) - limitPrice(left) || left.createdSequence - right.createdSequence)[0];
    if (opposite === undefined) return false;
    const price = limitPrice(opposite);
    let quantity = Math.min(market.remaining, opposite.remaining);
    if (market.side === "buy") {
      const account = this.requireAccount(run, market.accountId);
      const alreadySpent = market.quantity === market.remaining
        ? 0
        : run.trades
          .filter((trade) => trade.buyOrderId === market.orderId)
          .reduce((total, trade) => total + trade.price * trade.quantity, 0);
      const budget = Math.min(account.cash - account.reservedCash, (market.cashBudget ?? Number.MAX_SAFE_INTEGER) - alreadySpent);
      quantity = Math.min(quantity, Math.floor(budget / price));
    }
    if (quantity < 1) return false;
    const matched = market.side === "buy"
      ? { buyOrderId: market.orderId, sellOrderId: opposite.orderId, quantity, price }
      : { buyOrderId: opposite.orderId, sellOrderId: market.orderId, quantity, price };
    this.applyMatch(run, roundId, matched);
    return true;
  }

  private finishMarketOrder(run: MarketRun, action: SubmitMarketOrder): void {
    const order = run.orders.get(action.actionId);
    if (order === undefined) return;
    if (order.remaining === 0) return;
    if (action.timeInForce === "fok") throw precondition("market FOK order cannot be filled in full");
    this.release(run, order);
    order.status = "cancelled";
  }

  private cancel(run: MarketRun, action: CancelOrder): void {
    const order = run.orders.get(action.orderId);
    if (order === undefined || order.accountId !== action.accountId || order.status !== "open") {
      throw invalid("only an account's open order may be cancelled", "actions.orderId");
    }
    this.release(run, order);
    order.status = "cancelled";
  }

  private match(run: MarketRun, roundId: number): void {
    const matches = this.matcher.match(this.openOrders(run));
    for (const matched of matches) this.applyMatch(run, roundId, matched);
  }

  private applyMatch(
    run: MarketRun,
    roundId: number,
    matched: { buyOrderId: string; sellOrderId: string; quantity: number; price: number },
  ): void {
    const buy = run.orders.get(matched.buyOrderId);
    const sell = run.orders.get(matched.sellOrderId);
    if (buy === undefined || sell === undefined) throw invalid("matching adapter returned an unknown order");
    if (buy.status !== "open" || sell.status !== "open") throw invalid("matching adapter returned a non-open order");
    if (buy.side !== "buy" || sell.side !== "sell" || buy.accountId === sell.accountId) {
      throw invalid("matching adapter returned invalid order sides");
    }
    if (
      !Number.isSafeInteger(matched.quantity) ||
      !Number.isSafeInteger(matched.price) ||
      matched.quantity < 1 ||
      matched.quantity > buy.remaining ||
      matched.quantity > sell.remaining ||
      (sell.orderType !== "market" && matched.price < limitPrice(sell)) ||
      (buy.orderType !== "market" && matched.price > limitPrice(buy))
    ) {
      throw invalid("matching adapter returned an invalid fill");
    }
    this.settle(run, buy, sell, matched.quantity, matched.price);
    run.trades.push({
      tradeId: `trade:${run.runId}:${run.trades.length + 1}`,
      buyOrderId: buy.orderId,
      sellOrderId: sell.orderId,
      quantity: matched.quantity,
      price: matched.price,
      roundId,
    });
    for (const order of [buy, sell]) {
      if (order.remaining === 0) {
        order.status = "filled";
        this.release(run, order);
      }
    }
  }

  private settle(run: MarketRun, buy: Order, sell: Order, quantity: number, price: number): void {
    const buyer = this.requireAccount(run, buy.accountId);
    const seller = this.requireAccount(run, sell.accountId);
    const consideration = quantity * price;
    buyer.cash -= consideration;
    buyer.position += quantity;
    buyer.reservedCash -= quantity * (buy.orderType === "market" ? 0 : limitPrice(buy));
    seller.cash += consideration;
    seller.position -= quantity;
    seller.reservedPosition -= quantity;
    buy.remaining -= quantity;
    sell.remaining -= quantity;
    if (
      buyer.cash < 0 || buyer.reservedCash < 0 || seller.position < 0 || seller.reservedPosition < 0 ||
      buy.remaining < 0 || sell.remaining < 0
    ) {
      throw new Error("Financial Market reserve invariant violated");
    }
  }

  private release(run: MarketRun, order: Order): void {
    const account = this.requireAccount(run, order.accountId);
    if (order.side === "buy") {
      if (order.orderType !== "market") account.reservedCash -= order.remaining * limitPrice(order);
    } else {
      account.reservedPosition -= order.remaining;
    }
    order.remaining = 0;
    if (account.reservedCash < 0 || account.reservedPosition < 0) {
      throw new Error("Financial Market release invariant violated");
    }
  }

  /**
   * Financial owns quote replacement. A MarketMaker supplies only intent;
   * ordinary orders of the same account are deliberately untouched.
   */
  private replaceMarketMakerOrders(
    run: MarketRun,
    roundId: number,
    intents: readonly MarketMakerOrderIntent[],
    timing: MarketMakerTiming,
    matchAfterReplace = true,
    orderKey: string = timing,
  ): void {
    const selection = run.marketMaker;
    if (selection === undefined || selection.timing !== timing) return;
    for (const order of run.orders.values()) {
      if (order.origin === "market_maker" && order.status === "open") {
        this.release(run, order);
        order.status = "cancelled";
      }
    }
    const maker = this.requireAccount(run, selection.accountId);
    for (const [index, intent] of intents.entries()) {
      validateMarketMakerIntent(intent);
      // The class has no authority to bypass Financial's reserve model. A
      // quote that cannot be fully reserved is simply not placed.
      const available = intent.side === "buy"
        ? Math.floor((maker.cash - maker.reservedCash) / intent.limitPrice)
        : maker.position - maker.reservedPosition;
      if (available < intent.quantity) continue;
      this.submit(run, {
        type: "submitOrder",
        actionId: `market-maker:${roundId}:${orderKey}:${index}`,
        accountId: selection.accountId,
        side: intent.side,
        quantity: intent.quantity,
        limitPrice: intent.limitPrice,
        timeInForce: "gtc",
      }, "market_maker");
    }
    if (matchAfterReplace) this.match(run, roundId);
  }

  private openOrders(run: MarketRun): Order[] {
    return [...run.orders.values()].filter((order) => order.status === "open" && order.orderType !== "market").map((order) => clone(order));
  }

  private summaryFor(run: MarketRun, roundId: number): MarketSummary {
    const openOrders = this.openOrders(run);
    const bids = openOrders.filter((order) => order.side === "buy").map(limitPrice);
    const asks = openOrders.filter((order) => order.side === "sell").map(limitPrice);
    return {
      roundId,
      lastTradePrice: run.trades.at(-1)?.price ?? run.referencePrice,
      volume: run.trades.filter((trade) => trade.roundId === roundId).reduce((total, trade) => total + trade.quantity, 0),
      bestBid: bids.length === 0 ? 0 : Math.max(...bids),
      bestAsk: asks.length === 0 ? 0 : Math.min(...asks),
      openOrderCount: openOrders.length,
    };
  }

  private checkpoint(run: MarketRun, roundId: number): MarketCheckpoint {
    const digest = sha256({
      runId: run.runId,
      roundId,
      material: this.material(run),
    });
    return {
      ref: `checkpoint:financial_market:${run.runId}:round:${roundId}`,
      runId: run.runId,
      roundId,
      digest,
    };
  }

  private captureSeal(run: MarketRun, checkpoint: MarketCheckpoint, roundId: number): SealedState {
    const material = this.material(run);
    return {
      checkpoint: clone(checkpoint),
      facts: {
        checkpoint: clone(checkpoint),
        trades: material.trades.filter((trade) => trade.roundId <= roundId),
        summary: this.summaryFor(run, roundId),
      },
      material,
    };
  }

  private material(run: MarketRun): MaterialMarketState {
    return {
      ...(run.symbol === undefined ? {} : { symbol: run.symbol }),
      referencePrice: run.referencePrice,
      ...(run.priceScale === undefined ? {} : { priceScale: run.priceScale }),
      ...(run.tickSizeUnits === undefined ? {} : { tickSizeUnits: run.tickSizeUnits }),
      accounts: [...run.accounts.values()].sort(byAccount).map((item) => clone(item)),
      orders: [...run.orders.values()].sort(byOrder).map((item) => clone(item)),
      trades: clone(run.trades),
      sequence: run.sequence,
      publishedRound: run.publishedRound,
      ...(run.marketMaker === undefined ? {} : { marketMaker: clone(run.marketMaker) }),
    };
  }

  private runFromMaterial(runId: string, material: MaterialMarketState): MarketRun {
    return {
      runId,
      ...(material.symbol === undefined ? {} : { symbol: material.symbol }),
      referencePrice: material.referencePrice,
      ...(material.priceScale === undefined ? {} : { priceScale: material.priceScale }),
      ...(material.tickSizeUnits === undefined ? {} : { tickSizeUnits: material.tickSizeUnits }),
      accounts: new Map(material.accounts.map((item) => [item.accountId, clone(item)])),
      orders: new Map(material.orders.map((item) => {
        const normalized = { ...clone(item), orderType: item.orderType ?? "limit" } as Order;
        return [normalized.orderId, normalized];
      })),
      trades: clone(material.trades),
      sequence: material.sequence,
      publishedRound: material.publishedRound,
      ...(material.marketMaker === undefined ? {} : { marketMaker: clone(material.marketMaker) }),
      sealed: new Map(),
    };
  }


  private requireMarketMakerDraft(algorithmId: string): MarketMakerDraft {
    const draft = this.marketMakerRegistry.drafts[algorithmId];
    if (draft === undefined) throw notFound(`market maker draft not found: ${algorithmId}`);
    return draft;
  }

  private requirePublishedMarketMaker(versionRef: string): MarketMakerVersion {
    const version = this.marketMakerRegistry.versions[versionRef];
    if (version === undefined) throw notFound(`published market maker not found: ${versionRef}`);
    return version;
  }

  private snapshot(): FinancialMarketSnapshot {
    return {
      version: 2,
      runs: [...this.runs.values()].sort((left, right) => left.runId.localeCompare(right.runId)).map((run) => this.persistedRun(run)),
      idempotency: this.idempotency.snapshot(),
      marketMakerRegistry: clone(this.marketMakerRegistry),
      financialInitialStatePresetRegistry: clone(this.financialInitialStatePresetRegistry),
    };
  }

  private persistedRun(run: MarketRun): PersistedMarketRun {
    return {
      runId: run.runId,
      ...this.material(run),
      sealed: [...run.sealed.values()]
        .sort((left, right) => left.checkpoint.roundId - right.checkpoint.roundId)
        .map((sealed) => clone(sealed)),
    };
  }

  private restore(snapshot: FinancialMarketSnapshot): void {
    if (
      snapshot.version !== 2 ||
      !Array.isArray(snapshot.runs) ||
      !Array.isArray(snapshot.idempotency) ||
      !isMarketMakerRegistry(snapshot.marketMakerRegistry)
    ) {
      throw invalid("Financial Market state snapshot is invalid");
    }
    this.runs.clear();
    this.marketMakerRegistry = clone(snapshot.marketMakerRegistry);
    this.marketMakerRegistry.tombstones ??= [];
    this.financialInitialStatePresetRegistry = normalizeFinancialPresetRegistry(
      clone(snapshot.financialInitialStatePresetRegistry ?? { drafts: {}, versions: {} }),
    );
    for (const persisted of snapshot.runs) {
      const run = this.runFromMaterial(persisted.runId, persisted);
      run.sealed = new Map(
        persisted.sealed.map((seal) => [seal.checkpoint.roundId, clone(seal)]),
      );
      if (!run.sealed.has(run.publishedRound)) {
        throw invalid("Financial Market state has no committed checkpoint");
      }
      this.runs.set(run.runId, run);
    }
    this.idempotency.restore(snapshot.idempotency);
  }

  private async persist(): Promise<void> {
    if (this.stateStore !== undefined) await this.stateStore.save(this.snapshot());
  }
}

function normalizeFinancialPresetRegistry(registry: FinancialInitialStatePresetRegistry): FinancialInitialStatePresetRegistry {
  registry.tombstones ??= [];
  for (const item of [...Object.values(registry.drafts), ...Object.values(registry.versions)]) {
    if (!("mode" in item)) Object.assign(item, { mode: "fixed" });
  }
  return registry;
}

function isDeleted(tombstones: readonly AssetTombstone[], target: AssetDeleteTarget, assetId: string) {
  return tombstones.some((item) => item.target === target && item.assetId === assetId);
}

function accountFromSeed(seed: AccountSeed): Account {
  return {
    accountId: seed.accountId,
    cash: seed.initialCash,
    position: seed.initialPosition,
    maximumActionsPerRound: seed.maximumActionsPerRound,
    reservedCash: 0,
    reservedPosition: 0,
    ...(seed.initialStatePresetVersionRef === undefined ? {} : { initialStatePresetVersionRef: seed.initialStatePresetVersionRef }),
  };
}

function byAccount(left: Account, right: Account): number {
  return left.accountId.localeCompare(right.accountId);
}

function byOrder(left: Order, right: Order): number {
  return left.orderId.localeCompare(right.orderId);
}

function requireSafePositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${field} must be a positive safe integer`, field);
}

function requireSafeNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a non-negative safe integer`, field);
}

function limitPrice(order: Order): number {
  if (order.limitPrice === undefined) throw invalid("limit order is missing limitPrice", "orders.limitPrice");
  return order.limitPrice;
}

function requireRoundId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid("roundId must be a positive safe integer", "roundId");
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw invalid(`${field} must not be empty`, field);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMarketMakerLimits(limits: MarketMakerLimits | undefined): MarketMakerLimits {
  const value = limits ?? DEFAULT_MARKET_MAKER_LIMITS;
  if (!Number.isInteger(value.maxRuntimeMs) || value.maxRuntimeMs < 1 || value.maxRuntimeMs > 60_000) {
    throw invalid("maxRuntimeMs must be an integer between 1 and 60000", "limits.maxRuntimeMs");
  }
  if (!Number.isInteger(value.maxMemoryMb) || value.maxMemoryMb < 64 || value.maxMemoryMb > 1_024) {
    throw invalid("maxMemoryMb must be an integer between 64 and 1024", "limits.maxMemoryMb");
  }
  return { maxRuntimeMs: value.maxRuntimeMs, maxMemoryMb: value.maxMemoryMb };
}

function normalizeDependencies(dependencies: readonly string[] | undefined): string[] {
  const supported = new Set(["numpy", "networkx", "scipy", "pandas", "scikit-learn"]);
  const normalized = [...new Set((dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean))].sort();
  for (const dependency of normalized) {
    if (!supported.has(dependency)) throw invalid(`unsupported market maker dependency: ${dependency}`, "dependencies");
  }
  return normalized;
}

/** Small deterministic JSON-Schema subset for run/fork config admission. */
function validateMarketMakerConfig(schema: Record<string, unknown>, config: Record<string, unknown>): void {
  if (Object.keys(schema).length === 0) return;
  if (schema.type !== undefined && schema.type !== "object") {
    throw invalid("CONFIG_SCHEMA top level must describe an object", "marketMaker.config");
  }
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  for (const key of required) {
    if (config[key] === undefined) throw invalid(`market maker config requires ${key}`, `marketMaker.config.${key}`);
  }
  for (const [key, value] of Object.entries(config)) {
    const property = properties[key];
    if (property === undefined) continue;
    validateMarketMakerConfigValue(value, property, `marketMaker.config.${key}`);
  }
}

function effectiveMarketMakerConfig(
  version: Pick<MarketMakerVersion, "defaultConfig" | "configSchema">,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...clone(version.defaultConfig), ...clone(overrides) };
  validateMarketMakerConfig(version.configSchema, config);
  return config;
}

function validateMarketMakerConfigValue(value: unknown, schema: unknown, field: string): void {
  if (!isPlainRecord(schema)) return;
  const expected = schema.type;
  const valid = expected === undefined ||
    (expected === "string" && typeof value === "string") ||
    (expected === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (expected === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (expected === "boolean" && typeof value === "boolean") ||
    (expected === "array" && Array.isArray(value)) ||
    (expected === "object" && isPlainRecord(value));
  if (!valid) throw invalid(`market maker config value does not match ${String(expected)}`, field);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    throw invalid("market maker config value is not an allowed enum member", field);
  }
}

function validateMarketMakerIntent(intent: MarketMakerOrderIntent): void {
  if (intent.side !== "buy" && intent.side !== "sell") throw invalid("market maker order side is invalid", "marketMaker.orders.side");
  requireSafePositive(intent.limitPrice, "marketMaker.orders.limitPrice");
  requireSafePositive(intent.quantity, "marketMaker.orders.quantity");
}

function isMarketMakerRegistry(value: unknown): value is MarketMakerRegistry {
  return isPlainRecord(value) && isPlainRecord(value.drafts) && isPlainRecord(value.versions);
}
