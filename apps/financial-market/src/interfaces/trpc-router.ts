import { financialMcpPermissionsSchema } from "@openleek/contracts/agent";
import { checkpointSchema, committedFactQuerySchema, contextRevisionSchema } from "@openleek/contracts/context";
import { deleteDraftInputSchema, deleteVersionInputSchema } from "@openleek/contracts/assets";
import { dataDictionarySourceSchema } from "@openleek/contracts/data-dictionary";
import { identifierSchema, mutationHeaderSchema } from "@openleek/contracts/core";
import {
  financialCommittedFactsSchema,
  marketSummarySchema,
  tradeSchema,
} from "@openleek/contracts/observability";
import { candidateActionSchema, financialObservationSchema } from "@openleek/contracts/experiment";
import { financialInitialStatePresetDefinitionSchema, financialMarketSectionSchema } from "@openleek/contracts/world";
import { OpenLeekDomainError, domainProcedure, t } from "@openleek/trpc";
import { z } from "zod";
import { FinancialMarketService } from "../application/financial-market-service";
import { FinancialRevisionService } from "../application/revision-service";
import { FinancialMarketError, invalid } from "../domain/errors";
import { cashToUnits, priceToUnits, priceUnitsFromTickSize, unitsForSnapshot, type PriceUnits } from "../domain/price-units";
import type { FinancialMarketSection, MarketAction } from "../domain/models";
import type { FinancialContextRevision } from "../application/revision-model";
import { financialObserverQuerySchema, queryFinancialObserver } from "../application/observer-query";
import { financialDataDictionary } from "../domain/data-dictionary";

const roundInputSchema = z.object({ runId: z.string().min(1), roundId: z.number().int().positive() });
const marketActionInputSchema = z.array(candidateActionSchema).max(10_000);

const marketFactsSchema = z.object({
  checkpoint: checkpointSchema,
  trades: z.array(tradeSchema),
  summary: marketSummarySchema,
});
const checkpointResultSchema = z.object({ checkpoint: checkpointSchema });

/**
 * Context-local tRPC router. Network mounting is owned by the Financial Next
 * service; Experiment/Console must use the shared tRPC client, never import
 * this router or Financial persistence.
 */
export type FinancialMarketServiceProvider =
  | FinancialMarketService
  | (() => Promise<FinancialMarketService>);

export type FinancialRevisionServiceProvider =
  | FinancialRevisionService
  | (() => Promise<FinancialRevisionService>);

const revisionResultSchema = z.object({ revision: contextRevisionSchema });
const scopeResultSchema = z.object({
  scopeId: z.string().min(1),
  runId: z.string().min(1),
  roundId: z.number().int().positive(),
  agentId: z.string().min(1),
  principalId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  readRevisionRef: z.string().min(1),
  turnId: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  expiresAt: z.string().datetime(),
}).strict();
const mcpBindingSchema = z.object({
  context: z.literal("financial"),
  agentId: z.string().min(1),
  endpoint: z.string().url(),
});
const revisionAgentSchema = z.object({
  agentId: z.string().min(1),
  principalId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  permissions: financialMcpPermissionsSchema,
});
const marketMakerLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().min(1).max(60_000),
  maxMemoryMb: z.number().int().min(64).max(1_024),
}).strict();
const marketMakerDraftInputSchema = z.object({
  algorithmId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
  source: z.string().min(1).max(250_000),
  defaultConfig: z.record(z.string(), z.unknown()).default({}),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.string().min(1).max(100)).max(5).optional(),
  limits: marketMakerLimitsSchema.optional(),
}).strict();
const marketMakerOrderIntentSchema = z.object({
  side: z.enum(["buy", "sell"]),
  limitPrice: z.number().finite().positive(),
  quantity: z.number().int().positive(),
}).strict();

/**
 * A provider keeps the Next App Router composition root lazy: importing an
 * API route must not open a PostgreSQL connection before `/ready` or the first
 * tRPC request. Unit tests can still pass a concrete service directly.
 */
export function createFinancialMarketRouter(
  provider: FinancialMarketServiceProvider,
  revisionProvider?: FinancialRevisionServiceProvider,
) {
  const service = typeof provider === "function" ? provider : async () => provider;
  const revisions = revisionProvider === undefined
    ? undefined
    : typeof revisionProvider === "function" ? revisionProvider : async () => revisionProvider;
  const revisionService = async (): Promise<FinancialRevisionService> => {
    if (revisions === undefined) throw new Error("Financial revision runtime is not configured");
    return revisions();
  };
  return t.router({
    dataDictionary: t.router({
      catalog: domainProcedure
        .input(z.object({}).strict())
        .output(dataDictionarySourceSchema)
        .query(() => financialDataDictionary),
    }),
    financialInitialStatePresets: domainProcedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => invoke(async () => (await service()).listFinancialInitialStatePresets(input.includeDeleted))),
    financialInitialStatePresetDraft: domainProcedure.input(z.object({ presetId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => invoke(async () => (await service()).getFinancialInitialStatePresetDraft(input.presetId, input.includeDeleted))),
    financialInitialStatePresetVersion: domainProcedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => invoke(async () => (await service()).getFinancialInitialStatePresetVersion(input.versionRef, input.includeDeleted))),
    saveFinancialInitialStatePresetDraft: domainProcedure.input(z.union([
      z.object({ presetId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), definition: financialInitialStatePresetDefinitionSchema }).strict(),
      z.object({ presetId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), cash: z.number().finite().nonnegative(), positions: z.record(z.string(), z.number().finite().nonnegative()).default({}) }).strict(),
    ])).mutation(({ input }) => invoke(async () => (await service()).saveFinancialInitialStatePresetDraft({
      name: input.name,
      ...("definition" in input ? { definition: input.definition } : { cash: input.cash, positions: input.positions }),
      ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    }))),
    resolveFinancialInitialStatePreset: domainProcedure.input(z.object({
      versionRef: identifierSchema,
      seed: z.string().min(1),
      subjectId: identifierSchema,
      referencePrices: z.record(z.string(), z.number().finite().positive()),
      population: z.array(z.object({
        initialStatePresetVersionRef: identifierSchema,
        cash: z.number().finite().nonnegative(),
        positions: z.record(z.string(), z.number().int().nonnegative()),
      }).strict()),
    }).strict()).mutation(({ input }) => invoke(async () => (await service()).resolveFinancialInitialStatePreset(input))),
    publishFinancialInitialStatePreset: domainProcedure.input(z.object({ presetId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => invoke(async () => (await service()).publishFinancialInitialStatePreset(input))),
    deleteFinancialInitialStatePresetDraft: domainProcedure.input(deleteDraftInputSchema.extend({ presetId: identifierSchema }).strict()).mutation(({ input }) => invoke(async () => (await service()).deleteFinancialInitialStatePresetDraft(input))),
    deleteFinancialInitialStatePresetVersion: domainProcedure.input(deleteVersionInputSchema).mutation(({ input }) => invoke(async () => (await service()).deleteFinancialInitialStatePresetVersion(input))),
    /** Financial-owned Market Maker source library. */
    marketMakers: domainProcedure
      .input(z.object({ includeDeleted: z.boolean().optional() }).strict())
      .query(({ input }) => invoke(async () => (await service()).listMarketMakers(input.includeDeleted))),

    marketMakerDraft: domainProcedure
      .input(z.object({ algorithmId: identifierSchema, includeDeleted: z.boolean().optional() }).strict())
      .query(({ input }) => invoke(async () => (await service()).getMarketMakerDraft(input.algorithmId, input.includeDeleted))),

    marketMakerVersion: domainProcedure
      .input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict())
      .query(({ input }) => invoke(async () => (await service()).getMarketMakerVersion(input.versionRef, input.includeDeleted))),

    saveMarketMakerDraft: domainProcedure
      .input(marketMakerDraftInputSchema)
      .mutation(({ input }) => invoke(async () => (await service()).saveMarketMakerDraft({
        name: input.name,
        source: input.source,
        defaultConfig: input.defaultConfig,
        ...(input.algorithmId === undefined ? {} : { algorithmId: input.algorithmId }),
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        ...(input.configSchema === undefined ? {} : { configSchema: input.configSchema }),
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }))),

    validateMarketMaker: domainProcedure
      .input(z.object({
        algorithmId: identifierSchema,
        source: z.string().min(1).max(250_000).optional(),
        dependencies: z.array(z.string().min(1).max(100)).max(5).optional(),
        limits: marketMakerLimitsSchema.optional(),
      }).strict())
      .mutation(({ input }) => invoke(async () => (await service()).validateMarketMaker({
        algorithmId: input.algorithmId,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }))),

    publishMarketMaker: domainProcedure
      .input(z.object({ algorithmId: identifierSchema, expectedRevision: z.number().int().positive() }).strict())
      .mutation(({ input }) => invoke(async () => (await service()).publishMarketMaker(input))),

    deleteMarketMakerDraft: domainProcedure.input(deleteDraftInputSchema.extend({ algorithmId: identifierSchema }).strict()).mutation(({ input }) => invoke(async () => (await service()).deleteMarketMakerDraft(input))),
    deleteMarketMakerVersion: domainProcedure.input(deleteVersionInputSchema).mutation(({ input }) => invoke(async () => (await service()).deleteMarketMakerVersion(input))),

    /** Preview uses the same committed-only reader capability as live execution. */
    previewMarketMaker: domainProcedure
      .input(z.object({
        versionRef: identifierSchema,
        config: z.record(z.string(), z.unknown()).default({}),
        runId: identifierSchema,
        revisionRef: identifierSchema,
        seed: z.string().min(1).max(240),
        accountId: identifierSchema,
        timing: z.enum(["opening", "settlement"]),
      }).strict())
      .output(z.object({ orders: z.array(marketMakerOrderIntentSchema) }))
      .mutation(({ input }) => invoke(async () => ({
        orders: await (await revisionService()).previewMarketMaker(input),
      }))),

    validate: domainProcedure
      .input(financialMarketSectionSchema)
      .mutation(({ input }) => invoke(async () => {
        const instance = await service();
        const section = sectionFromContract(input);
        instance.validateSection(section);
        return { valid: true };
      })),

    initialize: domainProcedure
      .input(z.object({ runId: z.string().min(1), section: financialMarketSectionSchema, mutation: mutationHeaderSchema }))
      .output(checkpointResultSchema)
      .mutation(({ input }) => invoke(async () => {
        const instance = await service();
        return { checkpoint: await instance.initialize(input.runId, sectionFromContract(input.section), input.mutation) };
      })),

    open: domainProcedure
      .input(roundInputSchema.extend({ mutation: mutationHeaderSchema, baseline: checkpointSchema }))
      .output(marketSummarySchema)
      .mutation(({ input }) => invoke(async () => (await service()).openRound(input.runId, input.roundId, input.mutation))),

    observe: domainProcedure
      .input(roundInputSchema.extend({ baseline: checkpointSchema }))
      .output(financialObservationSchema)
      .query(({ input }) => invoke(async () => (await service()).getCommittedObservation(input.runId, input.baseline.ref))),

    // `apply` is reserved by tRPC v11's router proxy; Experiment maps its
    // logical Financial apply port onto this wire procedure.
    applyStep: domainProcedure
      .input(roundInputSchema.extend({
        mutation: mutationHeaderSchema,
        baseline: checkpointSchema,
        actions: marketActionInputSchema,
      }))
      .output(z.object({ trades: z.array(tradeSchema), summary: marketSummarySchema }))
      .mutation(({ input }) => invoke(async () => {
        const instance = await service();
        const units = unitsForSnapshot(instance.getFullSnapshot(input.runId, input.baseline.ref));
        return instance.apply(input.runId, input.roundId, actionsFromCandidates(input.actions, input.roundId, units), input.mutation);
      })),

    close: domainProcedure
      .input(roundInputSchema.extend({ mutation: mutationHeaderSchema, baseline: checkpointSchema }))
      .output(marketSummarySchema)
      .mutation(({ input }) => invoke(async () => (await service()).closeRound(input.runId, input.roundId, input.mutation))),

    seal: domainProcedure
      .input(roundInputSchema.extend({ mutation: mutationHeaderSchema }))
      .output(checkpointResultSchema)
      .mutation(({ input }) => invoke(async () => {
        const instance = await service();
        return { checkpoint: await instance.seal(input.runId, input.roundId, input.mutation) };
      })),

    publish: domainProcedure
      .input(roundInputSchema.extend({ mutation: mutationHeaderSchema, checkpoint: checkpointSchema }))
      .output(checkpointSchema)
      .mutation(({ input }) => invoke(async () => (await service()).publish(
        input.runId,
        input.roundId,
        input.checkpoint.ref,
        input.mutation,
      ))),

    fork: domainProcedure
      .input(z.object({
        sourceRunId: z.string().min(1),
        targetRunId: z.string().min(1),
        source: checkpointSchema,
        mutation: mutationHeaderSchema,
      }))
      .output(checkpointResultSchema)
      .mutation(({ input }) => invoke(async () => {
        const instance = await service();
        return { checkpoint: await instance.fork(input.sourceRunId, input.targetRunId, input.source.ref, input.mutation) };
      })),

    queryCommittedFacts: domainProcedure
      .input(committedFactQuerySchema.extend({
        roundId: z.number().int().nonnegative(),
        checkpointRef: z.string().min(1),
      }))
      .output(marketFactsSchema)
      .query(({ input }) => invoke(async () => (await service()).getCommittedFacts(input.runId, input.roundId, input.checkpointRef))),

    /** Manifest-facing immutable revision route; preserves legacy checkpoint API above. */
    queryCommittedRevisionFacts: domainProcedure
      .input(committedFactQuerySchema.extend({ revisionRef: z.string().min(1) }))
      .output(financialCommittedFactsSchema)
      .query(({ input }) => invoke(async () => (await revisionService()).getCommittedRevisionFacts(input.runId, input.revisionRef))),

    observer: domainProcedure
      .input(financialObserverQuerySchema)
      .query(({ input }) => invoke(async () => queryFinancialObserver(await revisionService(), input))),

    /** Git-like immutable revision APIs. Legacy checkpoint APIs remain above during migration. */
    revisionInitialize: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        section: financialMarketSectionSchema,
        mutation: mutationHeaderSchema,
        sourceManifestRef: z.string().min(1).optional(),
      }))
      .output(revisionResultSchema)
      .mutation(({ input }) => invoke(async () => {
        const market = await service();
        const checkpoint = await market.initialize(input.runId, sectionFromContract(input.section), input.mutation);
        const revision = await (await revisionService()).initializeRevision({
          runId: input.runId,
          checkpointRef: checkpoint.ref,
          ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        });
        return { revision };
      })),

    freezeFullSnapshot: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().positive(),
        baseline: contextRevisionSchema,
        mutation: mutationHeaderSchema,
        sourceManifestRef: z.string().min(1).optional(),
      }))
      .output(revisionResultSchema)
      .mutation(({ input }) => invoke(async () => {
        const revisionServiceInstance = await revisionService();
        const baseline = financialRevision(input.baseline);
        const revision = await revisionServiceInstance.freezeFullSnapshot({
          runId: input.runId,
          roundId: input.roundId,
          baseline,
          ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        });
        await revisionServiceInstance.openWorktree({
          runId: input.runId,
          roundId: input.roundId,
          baseRevision: baseline,
          readRevision: revision,
        });
        return { revision };
      })),

    mcpBindings: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().nonnegative(),
        revision: contextRevisionSchema,
        agents: z.array(revisionAgentSchema).min(1),
      }))
      .output(z.object({ bindings: z.array(mcpBindingSchema) }))
      .mutation(({ input }) => invoke(async () => ({
        bindings: await (await revisionService()).provisionMcpBindings({
          runId: input.runId,
          roundId: input.roundId,
          revision: financialRevision(input.revision),
          agents: input.agents.map((agent) => ({
            agentId: agent.agentId,
            principalId: agent.principalId,
            permissions: agent.permissions,
            ...(agent.accountId === undefined ? {} : { accountId: agent.accountId }),
          })),
        }),
      }))),

    openMcpScope: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().positive(),
        agentId: z.string().min(1),
        principalId: z.string().min(1),
        revision: contextRevisionSchema,
        turnId: z.string().min(1),
        attemptId: z.string().min(1).optional(),
      }))
      .output(scopeResultSchema)
      .mutation(({ input }) => invoke(async () => (await revisionService()).openMcpScope({
        runId: input.runId,
        roundId: input.roundId,
        agentId: input.agentId,
        principalId: input.principalId,
        readRevision: financialRevision(input.revision),
        turnId: input.turnId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      }))),

    closeMcpScope: domainProcedure
      .input(z.object({ runId: z.string().min(1), scopeId: z.string().min(1) }))
      .mutation(({ input }) => invoke(async () => {
        await (await revisionService()).closeMcpScope(input);
        return { closed: true };
      })),

    revokeMcpBindings: domainProcedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => invoke(async () => {
        await (await revisionService()).revokeMcpAccess(input.runId);
        return { revoked: true };
      })),

    /** Context-owned, read-only worker-drain barrier for Experiment. */
    settlementStatus: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().positive(),
        finalFailedTurnIds: z.array(z.string().min(1)).default([]),
      }))
      .output(z.object({
        settled: z.boolean(),
        pendingIntentCount: z.number().int().nonnegative(),
        pendingOutboxCount: z.number().int().nonnegative(),
      }))
      .query(({ input }) => invoke(async () => (await revisionService()).settlementStatus(input))),

    sealCandidateRevision: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().positive(),
        finalFailedTurnIds: z.array(z.string().min(1)),
        sourceManifestRef: z.string().min(1).optional(),
        mutation: mutationHeaderSchema,
      }))
      .output(revisionResultSchema)
      .mutation(({ input }) => invoke(async () => ({
        revision: await (await revisionService()).sealCandidateRevision({
          runId: input.runId,
          roundId: input.roundId,
          finalFailedTurnIds: input.finalFailedTurnIds,
          ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        }),
      }))),

    commitRevision: domainProcedure
      .input(z.object({ runId: z.string().min(1), revision: contextRevisionSchema, mutation: mutationHeaderSchema }))
      .output(revisionResultSchema)
      .mutation(({ input }) => invoke(async () => ({
        revision: await (await revisionService()).commitRevision(input.runId, input.revision.ref),
      }))),

    // Experiment uses this explicit name to make the global-manifest boundary
    // visible. It intentionally moves only Financial's local branch ref.
    commitCandidateRevision: domainProcedure
      .input(z.object({
        runId: z.string().min(1),
        roundId: z.number().int().positive(),
        candidateRevision: contextRevisionSchema,
        mutation: mutationHeaderSchema,
      }))
      .mutation(({ input }) => invoke(async () => {
        await (await revisionService()).commitRevision(input.runId, financialRevision(input.candidateRevision).ref);
        return { committed: true };
      })),

    forkRevision: domainProcedure
      .input(z.object({
        sourceRunId: z.string().min(1),
        targetRunId: z.string().min(1),
        sourceRevision: contextRevisionSchema,
        sourceManifestRef: z.string().min(1).optional(),
        marketMaker: z.object({
          versionRef: z.string().min(1),
          accountId: z.string().min(1),
          timing: z.enum(["opening", "settlement"]),
          matchingPolicy: z.enum(["batch", "incremental"]).optional(),
          requotePolicy: z.enum(["none", "after_each_trade"]).optional(),
          maxRequotesPerIntent: z.number().int().min(1).max(100_000).optional(),
          config: z.record(z.string(), z.unknown()).default({}),
        }).strict().superRefine((selection, context) => {
          if (selection.requotePolicy === "after_each_trade" && selection.matchingPolicy !== "incremental") {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["requotePolicy"], message: "after_each_trade requires incremental matching" });
          }
        }).nullable().optional(),
        mutation: mutationHeaderSchema,
      }))
      .output(revisionResultSchema)
      .mutation(({ input }) => invoke(async () => ({
        revision: await (await revisionService()).forkRevision({
          sourceRunId: input.sourceRunId,
          sourceRevisionRef: input.sourceRevision.ref,
          targetRunId: input.targetRunId,
          ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
          ...(input.marketMaker === undefined
            ? {}
            : { marketMaker: input.marketMaker === null ? null : marketMakerFromContract(input.marketMaker) }),
        }),
      }))),
  });
}

/**
 * The shared specification is multi-instrument. This first Financial runtime
 * uses a single durable book per run and rejects anything that would discard a
 * second instrument's balances. The explicit failure keeps migration safe
 * until a symbol-keyed book/state migration is introduced.
 */
export function sectionFromContract(input: z.infer<typeof financialMarketSectionSchema>): FinancialMarketSection {
  if (input.instruments.length !== 1) {
    throw invalid("Financial Market currently requires exactly one instrument", "section.instruments");
  }
  const instrument = input.instruments[0]!;
  const units = priceUnitsFromTickSize(instrument.tickSize ?? 1, "section.instruments[0].tickSize");
  const referencePrice = priceToUnits(instrument.referencePrice, units, "section.instruments[0].referencePrice");
  const accounts = input.accounts.map((account, index) => {
    const position = account.positions[instrument.symbol] ?? 0;
    requireIntegerTick(position, `section.accounts[${index}].positions.${instrument.symbol}`);
    for (const [symbol, value] of Object.entries(account.positions)) {
      if (symbol !== instrument.symbol && value !== 0) {
        throw invalid(
          "single-instrument Financial Market cannot discard a non-zero position",
          `section.accounts[${index}].positions.${symbol}`,
        );
      }
    }
    return {
      accountId: account.accountId,
      initialCash: cashToUnits(account.cash, units, `section.accounts[${index}].cash`),
      initialPosition: position,
      maximumActionsPerRound: account.maximumActionsPerRound,
      ...(account.initialStatePresetVersionRef === undefined ? {} : { initialStatePresetVersionRef: account.initialStatePresetVersionRef }),
    };
  });
  return {
    symbol: instrument.symbol,
    initialReferencePrice: referencePrice,
    priceScale: units.priceScale,
    tickSizeUnits: units.tickSizeUnits,
    accounts,
    ...(input.marketMaker === undefined ? {} : { marketMaker: marketMakerFromContract(input.marketMaker) }),
  };
}

function marketMakerFromContract(input: {
  versionRef: string;
  accountId: string;
  timing: "opening" | "settlement";
  matchingPolicy?: "batch" | "incremental" | undefined;
  requotePolicy?: "none" | "after_each_trade" | undefined;
  maxRequotesPerIntent?: number | undefined;
  config: Record<string, unknown>;
}): import("../domain/models").MarketMakerSelection {
  return {
    versionRef: input.versionRef,
    accountId: input.accountId,
    timing: input.timing,
    ...(input.matchingPolicy === undefined ? {} : { matchingPolicy: input.matchingPolicy }),
    ...(input.requotePolicy === undefined ? {} : { requotePolicy: input.requotePolicy }),
    ...(input.maxRequotesPerIntent === undefined ? {} : { maxRequotesPerIntent: input.maxRequotesPerIntent }),
    config: input.config,
  };
}

export function actionsFromCandidates(
  candidates: readonly z.infer<typeof candidateActionSchema>[],
  roundId: number,
  units: PriceUnits = { priceScale: 1, tickSizeUnits: 1 },
): MarketAction[] {
  const actionIds = new Set<string>();
  const orderIds = new Set<string>();
  const result: MarketAction[] = [];
  candidates.forEach((candidate, index) => {
    if (candidate.kind !== "financial.order" && candidate.kind !== "financial.cancel") return;
    if (actionIds.has(candidate.actionId)) {
      throw invalid("Financial candidate actionId values must be unique", `actions[${index}].actionId`);
    }
    actionIds.add(candidate.actionId);
    if (candidate.kind === "financial.order") {
      if (orderIds.has(candidate.orderId)) {
        throw invalid("Financial orderId values must be unique in a step", `actions[${index}].orderId`);
      }
      orderIds.add(candidate.orderId);
      requireIntegerTick(candidate.quantity, `actions[${index}].quantity`);
      const limitPrice = priceToUnits(candidate.limitPrice, units, `actions[${index}].limitPrice`);
      const expiresAtRound = candidate.ttlRounds === undefined ? undefined : roundId + candidate.ttlRounds;
      result.push({
        type: "submitOrder",
        // `orderId`, not actionId, is the durable book identity referenced by cancellation.
        actionId: candidate.orderId,
        accountId: candidate.accountId,
        side: candidate.side,
        quantity: candidate.quantity,
        limitPrice,
        ...(expiresAtRound === undefined ? {} : { expiresAtRound }),
        timeInForce: candidate.timeInForce,
      });
      return;
    }
    if (candidate.kind === "financial.cancel") {
      result.push({
        type: "cancelOrder",
        actionId: candidate.actionId,
        accountId: candidate.accountId,
        orderId: candidate.orderId,
      });
      return;
    }
    throw invalid("Financial Market apply accepts only financial candidate actions", `actions[${index}].kind`);
  });
  return result;
}

async function invoke<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FinancialMarketError) {
      throw new OpenLeekDomainError({
        code: error.code,
        message: error.message,
        violations: error.fieldViolations.map((item) => ({ field: item.field, message: item.message })),
      });
    }
    throw error;
  }
}

function financialRevision(value: {
  ref: string;
  context: "social_environment" | "financial_market";
  runId: string;
  roundId: number;
  digest: string;
  parentRevisionRef?: string | undefined;
  sourceManifestRef?: string | undefined;
}): FinancialContextRevision {
  if (value.context !== "financial_market") throw invalid("Financial operation requires a financial_market revision", "revision.context");
  return {
    ref: value.ref,
    context: "financial_market",
    runId: value.runId,
    roundId: value.roundId,
    digest: value.digest,
    ...(value.parentRevisionRef === undefined ? {} : { parentRevisionRef: value.parentRevisionRef }),
    ...(value.sourceManifestRef === undefined ? {} : { sourceManifestRef: value.sourceManifestRef }),
  };
}

function requireIntegerTick(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("Financial values must be non-negative integer ticks", field);
  }
}
