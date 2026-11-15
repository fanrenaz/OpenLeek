import { z } from "zod";
import { digestSchema, identifierSchema, mutationHeaderSchema, opaqueCursorSchema, type MutationHeader } from "./core";
import { checkpointSchema, commitStateSchema, contextRevisionSchema, dynamicContextRevisionSchema } from "./context";
import { agentExecutionSectionSchema, agentsMdVersionRefSchema, assetSelectionSchema } from "./agent";
import { turnPromptSelectionSchema } from "./turn-prompt";
import { financialMarketConfigurationSchema, nameThemeSchema, socialEnvironmentConfigurationSchema, socialNetworkSelectionSchema } from "./world";

export const runLifecycleSchema = z.enum([
  "queued",
  "initializing",
  "running",
  "retry_wait",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed",
]);


export const specificationSchema = z.object({
  schemaVersion: z.literal("1"),
  seed: z.number().int(),
  roundCount: z.number().int().min(1).max(10_000),
  clock: z.object({ startUnixSeconds: z.number().int(), stepSeconds: z.number().int().positive() }),
  executionPolicy: z.object({
    automaticRetryMaxAttempts: z.number().int().min(1).max(100).default(3),
    automaticRetryBackoffMs: z.number().int().min(0).max(3_600_000).default(1000),
    /** Omitted specifications retain the existing explicit resume boundary. */
    roundAdvancement: z.enum(["manual", "automatic"]).optional(),
  }).strict(),
  initialWorld: z.object({
    worldName: z.string().min(1).max(240),
    scenarioVersion: z.string().min(1).max(240),
    population: assetSelectionSchema,
    nameTheme: nameThemeSchema.default("research-codes-v1"),
  }).strict(),
  /** Experiment-owned per-round intervention selected and frozen for this Run. */
  turnPrompt: turnPromptSelectionSchema,
  agentExecution: agentExecutionSectionSchema,
  socialEnvironment: socialEnvironmentConfigurationSchema.and(z.object({
    socialNetwork: socialNetworkSelectionSchema.optional(),
  })),
  financialMarket: financialMarketConfigurationSchema,
}).strict();
export type Specification = z.infer<typeof specificationSchema>;
export const auditableSpecificationSchema = specificationSchema;
export type AuditableSpecification = Specification;

export const researchTemplateDefinitionSchema = z.object({
  requiredContexts: z.array(identifierSchema).max(100).default([]),
  optionalContexts: z.array(identifierSchema).max(100).default([]),
}).strict().superRefine((value, context) => {
  const required = new Set(value.requiredContexts);
  for (const id of value.optionalContexts) {
    if (required.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Context '${id}' cannot be both required and optional`, path: ["optionalContexts"] });
  }
});
export type ResearchTemplateDefinition = z.infer<typeof researchTemplateDefinitionSchema>;

export const researchTemplateVersionSchema = z.object({
  templateId: identifierSchema,
  versionRef: identifierSchema,
  name: z.string().min(1).max(240),
  definition: researchTemplateDefinitionSchema,
  artifactDigest: digestSchema,
  publishedAt: z.string().datetime(),
}).strict();
export type ResearchTemplateVersion = z.infer<typeof researchTemplateVersionSchema>;

/** Additive v2 shape used by the dynamic Context orchestrator migration. */
export const dynamicSpecificationSchema = specificationSchema.omit({
  schemaVersion: true,
  socialEnvironment: true,
  financialMarket: true,
}).extend({
  schemaVersion: z.literal("2"),
  researchTemplate: z.object({ versionRef: identifierSchema }).strict(),
  contexts: z.record(identifierSchema, z.object({
    installationRef: identifierSchema,
    descriptorRevision: identifierSchema,
    configuration: z.record(z.string(), z.unknown()).default({}),
  }).strict()),
}).strict();
export type DynamicSpecification = z.infer<typeof dynamicSpecificationSchema>;

/** First specification with no fixed Context projection or compatibility adapter. */
export const pluginSpecificationSchema = dynamicSpecificationSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal("3"),
}).strict();
export type PluginSpecification = z.infer<typeof pluginSpecificationSchema>;

export const runStatusSchema = z.object({
  runId: identifierSchema,
  lifecycle: runLifecycleSchema,
  committedRound: z.number().int().nonnegative(),
  configuredRounds: z.number().int().positive(),
  committedManifestRef: identifierSchema.optional(),
  /** Digest of every declared research condition, for Console audit. */
  conditionDigest: digestSchema,
  /** Terminal infrastructure failure that cannot be retried or silently replaced. */
  failure: z.object({
    category: z.string().min(1).max(120),
    message: z.string().min(1).max(10_000),
    occurredAt: z.string().datetime(),
  }).optional(),
  /** Durable visibility for a next-round freeze that is waiting to retry. */
  advanceRetry: z.object({
    roundId: z.number().int().positive(),
    attempts: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    nextRetryAt: z.string().datetime(),
    recentError: z.object({
      category: z.string().min(1).max(120),
      message: z.string().min(1).max(10_000),
      occurredAt: z.string().datetime(),
    }),
  }).optional(),
}).strict();
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runListResultSchema = z.object({
  runs: z.array(runStatusSchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict();

export const roundAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "committing",
  "retry_wait",
  "committed",
  "cancelled",
]);
export type RoundAttemptStatus = z.infer<typeof roundAttemptStatusSchema>;

export const agentJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type AgentJobStatus = z.infer<typeof agentJobStatusSchema>;

/** Browser-safe progress view. The immutable snapshot itself stays in Experiment. */
export const roundProgressSchema = z.object({
  runId: identifierSchema,
  roundId: z.number().int().positive(),
  snapshotId: identifierSchema,
  snapshotDigest: digestSchema,
  attempt: z.number().int().positive(),
  state: roundAttemptStatusSchema,
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failureCategories: z.record(z.string(), z.number().int().positive()),
  recentError: z.string().max(10_000).optional(),
});
export type RoundProgress = z.infer<typeof roundProgressSchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal("2").default("2"),
  ref: identifierSchema,
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  state: commitStateSchema,
  /** The prior run HEAD (or the source HEAD for a fork). */
  parentManifestRef: identifierSchema.optional(),
  agentExecution: checkpointSchema,
  socialEnvironment: contextRevisionSchema,
  financialMarket: contextRevisionSchema,
  /** Canonical Context-indexed view. Fixed owner fields are internal migration mirrors. */
  contexts: z.record(identifierSchema, dynamicContextRevisionSchema).default({}),
  digest: digestSchema,
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export const committedManifestSchema = manifestSchema.extend({ state: z.literal("committed") });
export const committedRoundListSchema = z.object({
  items: z.array(committedManifestSchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict();

export const dynamicManifestSchema = manifestSchema.omit({
  socialEnvironment: true,
  financialMarket: true,
}).strict();
export type DynamicManifest = z.infer<typeof dynamicManifestSchema>;

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal("3"),
  ref: identifierSchema,
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  state: commitStateSchema,
  parentManifestRef: identifierSchema.optional(),
  agentExecution: checkpointSchema,
  contexts: z.record(identifierSchema, dynamicContextRevisionSchema),
  digest: digestSchema,
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const committedPluginManifestSchema = pluginManifestSchema.extend({ state: z.literal("committed") });
export const committedPluginRoundListSchema = z.object({
  items: z.array(committedPluginManifestSchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict();

const candidateActionBaseSchema = z.object({ actionId: identifierSchema });
export const candidateActionSchema = z.discriminatedUnion("kind", [
  candidateActionBaseSchema.extend({ kind: z.literal("social.post"), actorId: identifierSchema, postId: identifierSchema, headline: z.string().min(1).max(500), body: z.string().min(1).max(10_000) }),
  candidateActionBaseSchema.extend({ kind: z.literal("social.follow"), followerId: identifierSchema, followeeId: identifierSchema }),
  candidateActionBaseSchema.extend({ kind: z.literal("social.unfollow"), followerId: identifierSchema, followeeId: identifierSchema }),
  candidateActionBaseSchema.extend({ kind: z.literal("social.engage"), actorId: identifierSchema, postId: identifierSchema, engagement: z.enum(["like", "repost", "reply"]), replyBody: z.string().min(1).max(10_000).optional() }),
  candidateActionBaseSchema.extend({ kind: z.literal("financial.order"), accountId: identifierSchema, orderId: identifierSchema, symbol: z.string().min(1), side: z.enum(["buy", "sell"]), quantity: z.number().finite().positive(), limitPrice: z.number().finite().positive(), timeInForce: z.enum(["gtc", "ioc", "fok"]).default("gtc"), ttlRounds: z.number().int().positive().optional() }),
  candidateActionBaseSchema.extend({ kind: z.literal("financial.cancel"), accountId: identifierSchema, orderId: identifierSchema }),
]);
export type CandidateAction = z.infer<typeof candidateActionSchema>;

/** Committed-baseline views passed to Agent Execution in request order. */
export const socialPostPreviewSchema = z.object({
  postId: identifierSchema,
  actorId: identifierSchema,
  headline: z.string().min(1).max(500),
  body: z.string().min(1).max(10_000),
});
export const socialAgentObservationSchema = z.object({
  agentId: identifierSchema,
  feed: z.array(socialPostPreviewSchema),
  followerCount: z.number().int().nonnegative(),
});
export const socialObservationSchema = z.object({ agents: z.array(socialAgentObservationSchema) });
export type SocialObservation = z.infer<typeof socialObservationSchema>;
export const financialAccountObservationSchema = z.object({
  accountId: identifierSchema,
  cash: z.number().finite().nonnegative(),
  positions: z.record(z.string(), z.number().finite()),
});
export const marketQuoteSchema = z.object({ symbol: z.string().min(1), bid: z.number().finite().positive().optional(), ask: z.number().finite().positive().optional(), last: z.number().finite().positive().optional() });
export const financialObservationSchema = z.object({ accounts: z.array(financialAccountObservationSchema), quotes: z.array(marketQuoteSchema) });
export type FinancialObservation = z.infer<typeof financialObservationSchema>;
export const agentObservationSchema = z.object({
  agentId: identifierSchema,
  social: socialAgentObservationSchema,
  financial: financialAccountObservationSchema,
  quotes: z.array(marketQuoteSchema),
});
export type AgentObservation = z.infer<typeof agentObservationSchema>;


/** The sole public creation contract. Runtime v1 specifications are not accepted. */
export const createRunInputSchema = z.object({ mutation: mutationHeaderSchema, specification: pluginSpecificationSchema });
export const runCommandInputSchema = z.object({ mutation: mutationHeaderSchema, runId: identifierSchema });
export const forkRunInputSchema = z.object({
  mutation: mutationHeaderSchema,
  sourceRunId: identifierSchema,
  sourceManifestRef: identifierSchema,
  /** Omit to inherit, or select any published Turn Prompt including the system preset. */
  turnPrompt: turnPromptSelectionSchema.optional(),
  /** Explicit per-member cognition intervention; world state and IDs are inherited. */
  agentsMdByAgentId: z.record(identifierSchema, agentsMdVersionRefSchema).default({}),
  contextConfigurations: z.record(identifierSchema, z.record(z.string(), z.unknown())).default({}),
}).strict();
