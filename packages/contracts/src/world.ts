import { z } from "zod";
import { digestSchema, identifierSchema } from "./core";
import { agentsMdVersionRefSchema, frozenSkillBindingSchema } from "./agent";

export const agentTypeSchema = z.enum(["retail_investor", "media", "market_maker"]);
export const researchAgentTypeSchema = z.enum(["retail_investor", "media"]);

const fixedFinancialInitialStatePresetSchema = z.object({
  mode: z.literal("fixed").default("fixed"),
  cash: z.number().finite().nonnegative(),
  positions: z.record(z.string().min(1).max(32), z.number().finite().nonnegative()).default({}),
}).strict();
const deterministicIssuancePresetSchema = z.object({
  mode: z.literal("deterministic_issuance"),
  cash: z.number().finite().nonnegative(),
  symbol: z.string().min(1).max(32),
  issuePrice: z.number().finite().positive(),
  buckets: z.array(z.object({
    weight: z.number().finite().positive(),
    spendCashFraction: z.number().finite().min(0).max(1),
  }).strict()).min(1).max(100),
  seedSalt: z.string().min(1).max(240),
}).strict();
const populationRelativePresetSchema = z.object({
  mode: z.literal("population_relative"),
  sourcePresetVersionRefs: z.array(identifierSchema).min(1).max(100),
  wealthFraction: z.number().finite().min(0).max(1),
  targetAssetValueFraction: z.number().finite().min(0).max(1),
  symbol: z.string().min(1).max(32),
}).strict();
export const financialInitialStatePresetDefinitionSchema = z.union([
  fixedFinancialInitialStatePresetSchema,
  deterministicIssuancePresetSchema,
  populationRelativePresetSchema,
]);
export type FinancialInitialStatePresetDefinition = z.infer<typeof financialInitialStatePresetDefinitionSchema>;

export const populationEntrySchema = z.object({
  key: identifierSchema,
  count: z.number().int().min(1).max(100_000),
  agentBlueprintVersionRef: identifierSchema,
}).strict();
export type PopulationEntry = z.infer<typeof populationEntrySchema>;

export const populationDefinitionSchema = z.object({
  entries: z.array(populationEntrySchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  let total = 0;
  value.entries.forEach((entry, index) => {
    if (keys.has(entry.key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "key"], message: "must be unique" });
    keys.add(entry.key);
    total += entry.count;
  });
  if (total > 100_000) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "total population must not exceed 100000" });
});
export type PopulationDefinition = z.infer<typeof populationDefinitionSchema>;

export const socialNetworkSelectionSchema = z.object({
  versionRef: identifierSchema,
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type SocialNetworkSelection = z.infer<typeof socialNetworkSelectionSchema>;

/**
 * The population generator owns the complete repeatable subject-type
 * definition: AGENTS.md binding, Social seed, Financial seed, and capability
 * policy.  The core intentionally has no universal `subjectTypes` schema.
 */
export const worldGeneratorSelectionSchema = z.object({
  versionRef: identifierSchema,
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type WorldGeneratorSelection = z.infer<typeof worldGeneratorSelectionSchema>;

export const nameThemeSchema = z.enum([
  "research-codes-v1",
  "three-kingdoms-v1",
  "journey-to-the-west-v1",
  "wandering-swords-v1",
  "wizard-academy-v1",
  "deep-space-crew-v1",
  "mythic-creatures-v1",
  "cyber-city-v1",
]);
export type NameTheme = z.infer<typeof nameThemeSchema>;

export const resolvedProfileMemberSchema = z.object({
  slotId: identifierSchema,
  cohortKey: identifierSchema,
  cohortIndex: z.number().int().positive(),
  agentId: identifierSchema,
  displayName: z.string().min(1).max(240),
  agentBlueprintVersionRef: identifierSchema,
  agentsMdVersionRef: agentsMdVersionRefSchema,
  skills: z.array(frozenSkillBindingSchema).max(100).default([]),
  actorId: identifierSchema.optional(),
  accountId: identifierSchema.optional(),
}).strict();
export type ResolvedProfileMember = z.infer<typeof resolvedProfileMemberSchema>;

export const networkRelationshipSchema = z.object({
  followerSlotId: identifierSchema,
  followeeSlotId: identifierSchema,
}).strict();
export const networkGeneratorResultSchema = z.object({
  relationships: z.array(networkRelationshipSchema).max(1_000_000).default([]),
}).strict();
export type NetworkGeneratorResult = z.infer<typeof networkGeneratorResultSchema>;

export const resolvedWorldSchema = z.object({
  population: z.array(resolvedProfileMemberSchema).min(1),
  relationships: z.array(networkRelationshipSchema),
  digest: digestSchema,
}).strict();
export type ResolvedWorld = z.infer<typeof resolvedWorldSchema>;

export const socialActorSchema = z.object({
  actorId: identifierSchema,
  displayName: z.string().min(1).max(240),
  maximumActionsPerRound: z.number().int().min(0).max(1_000),
}).strict();
/**
 * A published feed algorithm is immutable.  The source lives in Social's
 * algorithm registry; specifications retain only this reproducible pointer
 * and its per-run configuration.
 */
export const feedAlgorithmSelectionSchema = z.object({
  versionRef: identifierSchema,
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type FeedAlgorithmSelection = z.infer<typeof feedAlgorithmSelectionSchema>;

export const socialEnvironmentSectionSchema = z.object({
  /**
   * A policy controls which Resource roots an agent can discover.  It is not
   * a snapshot boundary: every projection is read from the same full revision.
   */
  exposurePolicy: z.enum(["recommendation_only", "public_browse"]),
  actors: z.array(socialActorSchema).default([]),
  relationships: z.array(z.object({
    followerId: identifierSchema,
    followeeId: identifierSchema,
  })).default([]),
  ranking: z.object({
    recencyWeight: z.number().finite().nonnegative().default(1),
    engagementWeight: z.number().finite().nonnegative().default(1),
  }).optional(),
  feedAlgorithm: feedAlgorithmSelectionSchema.optional(),
  feedSize: z.number().int().min(1).max(1_000).default(100),
  audienceReception: z.object({
    engagementProbability: z.number().finite().min(0).max(1).default(0.1),
    repostProbability: z.number().finite().min(0).max(1).default(0.02),
  }).default({ engagementProbability: 0.1, repostProbability: 0.02 }),
}).superRefine((section, context) => {
  if (section.feedAlgorithm !== undefined && section.ranking !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ranking"],
      message: "ranking and feedAlgorithm cannot coexist; use the built-in default or a published feed algorithm",
    });
  }
});
export type SocialEnvironmentSection = z.infer<typeof socialEnvironmentSectionSchema>;

export const financialAccountSchema = z.object({
  accountId: identifierSchema,
  cash: z.number().finite().nonnegative(),
  positions: z.record(z.string(), z.number().finite()).default({}),
  maximumActionsPerRound: z.number().int().min(0).max(1_000),
  initialStatePresetVersionRef: identifierSchema.optional(),
}).strict();
/**
 * A published Market Maker implementation is owned by Financial.  Runs retain
 * only its immutable version, the account it is allowed to quote from, when it
 * runs, and per-run configuration.
 */
export const marketMakerSelectionSchema = z.object({
  versionRef: identifierSchema,
  initialStatePresetVersionRef: identifierSchema,
  timing: z.enum(["opening", "settlement"]),
  matchingPolicy: z.enum(["batch", "incremental"]).optional(),
  requotePolicy: z.enum(["none", "after_each_trade"]).optional(),
  maxRequotesPerIntent: z.number().int().min(1).max(100_000).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((selection, context) => {
  if (selection.requotePolicy === "after_each_trade" && selection.matchingPolicy !== "incremental") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requotePolicy"], message: "after_each_trade requires incremental matching" });
  }
});
export type MarketMakerSelection = z.infer<typeof marketMakerSelectionSchema>;

export const resolvedMarketMakerSelectionSchema = z.object({
  versionRef: identifierSchema,
  accountId: identifierSchema,
  timing: z.enum(["opening", "settlement"]),
  matchingPolicy: z.enum(["batch", "incremental"]).optional(),
  requotePolicy: z.enum(["none", "after_each_trade"]).optional(),
  maxRequotesPerIntent: z.number().int().min(1).max(100_000).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((selection, context) => {
  if (selection.requotePolicy === "after_each_trade" && selection.matchingPolicy !== "incremental") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requotePolicy"], message: "after_each_trade requires incremental matching" });
  }
});
export type ResolvedMarketMakerSelection = z.infer<typeof resolvedMarketMakerSelectionSchema>;

export const financialMarketSectionSchema = z.object({
  accounts: z.array(financialAccountSchema),
  instruments: z.array(z.object({
    symbol: z.string().min(1).max(32),
    referencePrice: z.number().finite().positive(),
    tickSize: z.number().finite().positive().optional(),
  })).min(1),
  marketMaker: resolvedMarketMakerSelectionSchema.optional(),
}).strict().superRefine((section, context) => {
  section.instruments.forEach((instrument, index) => {
    const tickSize = instrument.tickSize ?? 1;
    if (decimalPlaces(tickSize) > 8) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "tickSize"], message: "supports at most 8 decimal places" });
      return;
    }
    const quotient = instrument.referencePrice / tickSize;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-8) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "referencePrice"], message: `must be aligned to tickSize ${tickSize}` });
    }
  });
  if (section.marketMaker !== undefined && !section.accounts.some((account) => account.accountId === section.marketMaker!.accountId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["marketMaker", "accountId"],
      message: "must reference a Financial account",
    });
  }
});

function decimalPlaces(value: number): number {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  return Math.max(0, (mantissa!.split(".")[1] ?? "").length - (exponentText === undefined ? 0 : Number(exponentText)));
}
export type FinancialMarketSection = z.infer<typeof financialMarketSectionSchema>;

/**
 * Inputs that configure the Contexts but do not own per-subject facts.  Actor
 * and account seeds are produced by the selected Population plugin, then
 * materialized only in the run's resolved world.
 */
export const socialEnvironmentConfigurationSchema = z.object({
  exposurePolicy: z.enum(["recommendation_only", "public_browse"]),
  ranking: z.object({
    recencyWeight: z.number().finite().nonnegative().default(1),
    engagementWeight: z.number().finite().nonnegative().default(1),
  }).optional(),
  feedAlgorithm: feedAlgorithmSelectionSchema.optional(),
  feedSize: z.number().int().min(1).max(1_000).default(100),
  audienceReception: z.object({
    engagementProbability: z.number().finite().min(0).max(1).default(0.1),
    repostProbability: z.number().finite().min(0).max(1).default(0.02),
  }).default({ engagementProbability: 0.1, repostProbability: 0.02 }),
}).superRefine((section, context) => {
  if (section.feedAlgorithm !== undefined && section.ranking !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ranking"],
      message: "ranking and feedAlgorithm cannot coexist; use the built-in default or a published feed algorithm",
    });
  }
});
export type SocialEnvironmentConfiguration = z.infer<typeof socialEnvironmentConfigurationSchema>;

export const financialMarketConfigurationSchema = z.object({
  instruments: z.array(z.object({
    symbol: z.string().min(1).max(32),
    referencePrice: z.number().finite().positive(),
    tickSize: z.number().finite().positive().optional(),
  })).min(1),
  /** The maker account is selected from the resolved Population output. */
  marketMaker: marketMakerSelectionSchema.optional(),
}).strict().superRefine((section, context) => {
  section.instruments.forEach((instrument, index) => {
    const tickSize = instrument.tickSize ?? 1;
    if (decimalPlaces(tickSize) > 8) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "tickSize"], message: "supports at most 8 decimal places" });
      return;
    }
    const quotient = instrument.referencePrice / tickSize;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-8) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "referencePrice"], message: `must be aligned to tickSize ${tickSize}` });
    }
  });
});
export type FinancialMarketConfiguration = z.infer<typeof financialMarketConfigurationSchema>;
