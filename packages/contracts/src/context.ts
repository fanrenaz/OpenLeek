import { z } from "zod";
import { digestSchema, identifierSchema, operationReceiptSchema, pageInputSchema } from "./core";

/** Browser-safe metadata published by a runtime Context plugin. */
export const localizedTextSchema = z.object({
  default: z.string().min(1).max(1_000),
  translations: z.record(z.string().min(2).max(35), z.string().min(1).max(1_000)).default({}),
}).strict();
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export const contextCapabilitySchema = z.object({
  id: identifierSchema,
  kind: z.enum(["tool", "resource"]),
  label: localizedTextSchema,
  description: localizedTextSchema.optional(),
}).strict();
export type ContextCapability = z.infer<typeof contextCapabilitySchema>;

export const contextAssetCollectionSchema = z.object({
  id: identifierSchema,
  label: localizedTextSchema,
  description: localizedTextSchema.optional(),
  /** JSON Schema is deliberately opaque to the shared domain contract. */
  definitionSchema: z.record(z.string(), z.unknown()).default({}),
  uiSchema: z.record(z.string(), z.unknown()).default({}),
  actions: z.array(z.enum(["list", "draft", "save", "validate", "publish", "preview", "delete"])).min(1),
}).strict();
export type ContextAssetCollection = z.infer<typeof contextAssetCollectionSchema>;

export const contextDescriptorSchema = z.object({
  schemaVersion: z.literal("1"),
  contextId: identifierSchema,
  revision: identifierSchema,
  label: localizedTextSchema,
  description: localizedTextSchema,
  agentEnvironment: z.object({
    accountPolicySchema: z.record(z.string(), z.unknown()).default({}),
    accountPolicyUiSchema: z.record(z.string(), z.unknown()).default({}),
    capabilities: z.array(contextCapabilitySchema).max(1_000).default([]),
  }).strict(),
  worldEnvironment: z.object({
    collections: z.array(contextAssetCollectionSchema).max(100).default([]),
  }).strict(),
  experimentConfigurationSchema: z.record(z.string(), z.unknown()).default({}),
  experimentConfigurationUiSchema: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ContextDescriptor = z.infer<typeof contextDescriptorSchema>;

/** Infrastructure a Context installation asks the platform to provision. */
export const contextInfrastructureSchema = z.object({
  postgres: z.boolean().default(false),
  redis: z.boolean().default(false),
}).strict();
export type ContextInfrastructure = z.infer<typeof contextInfrastructureSchema>;

/**
 * v2 adds deployment requirements and the shared runtime protocol without
 * changing the browser-safe v1 descriptor consumed by existing Consoles.
 */
export const contextRuntimeDescriptorSchema = contextDescriptorSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal("2"),
  runtimeProtocol: z.literal("openleek-context-runtime/v1"),
  infrastructure: contextInfrastructureSchema.default({ postgres: false, redis: false }),
  agentAccess: z.enum(["read-only", "read-write", "none"]).default("read-write"),
}).strict();
export type ContextRuntimeDescriptor = z.infer<typeof contextRuntimeDescriptorSchema>;
export const contextUiModuleSchema = z.object({
  apiVersion: z.literal("openleek-context-ui/v1"),
  path: z.string().startsWith("/"),
  sha256: digestSchema,
  elements: z.object({
    configuration: z.string().regex(/^openleek-[a-z0-9-]+-[a-z0-9-]+$/).optional(),
    assets: z.string().regex(/^openleek-[a-z0-9-]+-[a-z0-9-]+$/).optional(),
    observer: z.string().regex(/^openleek-[a-z0-9-]+-[a-z0-9-]+$/).optional(),
    facts: z.string().regex(/^openleek-[a-z0-9-]+-[a-z0-9-]+$/).optional(),
  }).strict(),
}).strict();

export const contextObserverViewSchema = z.object({
  id: identifierSchema,
  label: localizedTextSchema,
  inputSchema: z.record(z.string(), z.unknown()).default({}),
}).strict();

/** Pure plugin descriptor consumed by Registry, Experiment and Console. */
export const contextPluginDescriptorSchema = contextDescriptorSchema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal("3"),
  runtimeProtocol: z.literal("openleek-context-runtime/v2"),
  infrastructure: contextInfrastructureSchema.default({ postgres: false, redis: false }),
  agentAccess: z.enum(["read-only", "read-write", "none"]).default("read-write"),
  observerViews: z.array(contextObserverViewSchema).max(100).default([]),
  uiModule: contextUiModuleSchema.optional(),
}).strict();
export type ContextPluginDescriptor = z.infer<typeof contextPluginDescriptorSchema>;
export const anyContextDescriptorSchema = z.union([contextDescriptorSchema, contextRuntimeDescriptorSchema, contextPluginDescriptorSchema]);
export type AnyContextDescriptor = z.infer<typeof anyContextDescriptorSchema>;

export const contextInstallationStateSchema = z.enum([
  "draft",
  "provisioned",
  "active",
  "draining",
  "disabled",
  "failed",
]);
export type ContextInstallationState = z.infer<typeof contextInstallationStateSchema>;

export const contextInstallationSchema = z.object({
  installationRef: identifierSchema,
  contextId: identifierSchema,
  endpoint: z.string().url(),
  descriptorRevision: identifierSchema.optional(),
  state: contextInstallationStateSchema,
  management: z.enum(["platform", "self-managed"]),
  infrastructure: contextInfrastructureSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  failure: z.string().min(1).max(10_000).optional(),
}).strict();
export type ContextInstallation = z.infer<typeof contextInstallationSchema>;

export const contextInstallationCreateSchema = z.object({
  contextId: identifierSchema,
  endpoint: z.string().url(),
  management: z.enum(["platform", "self-managed"]),
  infrastructure: contextInfrastructureSchema.default({ postgres: false, redis: false }),
}).strict();

/** Secret bootstrap material is returned only once to the Console operator. */
export const contextBootstrapBundleSchema = z.object({
  installationRef: identifierSchema,
  bearerToken: z.string().min(32),
  environment: z.record(z.string(), z.string()),
}).strict();
export type ContextBootstrapBundle = z.infer<typeof contextBootstrapBundleSchema>;

export const contextRuntimeSettlementSchema = z.object({
  settled: z.boolean(),
  pendingCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
}).strict();

export const contextRuntimeBindingSchema = z.object({
  contextId: identifierSchema,
  agentId: identifierSchema,
  endpoint: z.string().url(),
  bearerToken: z.string().min(1),
  tools: z.array(identifierSchema),
  resources: z.array(identifierSchema),
}).strict();
export type ContextRuntimeBinding = z.infer<typeof contextRuntimeBindingSchema>;

export const contextCatalogEntrySchema = z.union([
  contextDescriptorSchema.extend({ available: z.boolean() }).strict(),
  contextRuntimeDescriptorSchema.extend({ available: z.boolean() }).strict(),
  contextPluginDescriptorSchema.extend({ available: z.boolean() }).strict(),
]);
export const contextCatalogSchema = z.object({
  contexts: z.array(contextCatalogEntrySchema),
}).strict();
export type ContextCatalog = z.infer<typeof contextCatalogSchema>;

export const contextAssetReadSchema = z.object({
  contextId: identifierSchema,
  collectionId: identifierSchema,
  operation: z.enum(["list", "draft", "version"]),
  id: identifierSchema.optional(),
  includeDeleted: z.boolean().optional(),
}).strict();
export const contextAssetCommandSchema = z.object({
  contextId: identifierSchema,
  collectionId: identifierSchema,
  operation: z.enum(["save", "validate", "publish", "preview", "delete"]),
  input: z.unknown(),
}).strict();

/** Stable, cross-service capability identifiers used by published MCP Policies. */

export const commitStateSchema = z.enum(["pending", "sealed", "publishing", "committed"]);
export const checkpointSchema = z.object({
  ref: identifierSchema,
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  digest: digestSchema,
  parentRef: identifierSchema.optional(),
  /** Present for Agent Execution checkpoints after static artifacts are materialized. */
  staticArtifactDigest: digestSchema.optional(),
  /** Fixed model selected by Agent Execution for this Run. */
  model: identifierSchema.optional(),
  /** Digest of the complete non-secret Codex configuration materialized for the Run. */
  codexConfigDigest: digestSchema.optional(),
  /** Agent Execution-owned repeat budget frozen for this checkpoint. */
  toolCallBudget: z.object({
    maxCallsPerToolPerTurn: z.number().int().min(1).max(100),
  }).strict().optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * A Context-owned immutable version.  Revisions are content-addressed by
 * their digest and form a copy-on-write lineage inside their owning Context.
 * Experiment only stores these references; it never stores the Context facts.
 */
export const contextNameSchema = z.enum(["social_environment", "financial_market"]);
export type ContextName = z.infer<typeof contextNameSchema>;
export const contextRevisionSchema = z.object({
  ref: identifierSchema,
  context: contextNameSchema,
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  digest: digestSchema,
  parentRevisionRef: identifierSchema.optional(),
  /** The committed manifest from which this revision was derived, when any. */
  sourceManifestRef: identifierSchema.optional(),
}).strict();
export type ContextRevision = z.infer<typeof contextRevisionSchema>;
export const dynamicContextRevisionSchema = contextRevisionSchema.omit({ context: true }).extend({
  context: identifierSchema,
}).strict();
export type DynamicContextRevision = z.infer<typeof dynamicContextRevisionSchema>;

export const contextParticipantSchema = z.object({
  agentId: identifierSchema,
  principalId: identifierSchema,
  displayName: z.string().min(1).max(240),
  profile: z.object({ slotId: identifierSchema, cohortKey: identifierSchema, cohortIndex: z.number().int().positive() }).strict(),
  accountPolicy: z.record(z.string(), z.unknown()).default({}),
  tools: z.array(identifierSchema).max(1_000).default([]),
  resources: z.array(identifierSchema).max(1_000).default([]),
  bearerToken: z.string().min(1),
}).strict();
export type ContextParticipant = z.infer<typeof contextParticipantSchema>;

const runtimeMutationSchema = z.object({
  transitionId: identifierSchema,
  stepId: identifierSchema,
  payloadDigest: digestSchema,
  expectedCheckpointRef: z.string().max(240),
}).strict();

const runtimeRunSchema = z.object({
  runId: identifierSchema,
  seed: z.number().int(),
  roundCount: z.number().int().positive(),
  clock: z.object({ startUnixSeconds: z.number().int(), stepSeconds: z.number().int().positive() }).strict(),
}).strict();

/** Every v2 lifecycle request is installation-authenticated and idempotent. */
export const contextRuntimeOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("validate"), configuration: z.record(z.string(), z.unknown()), participants: z.array(contextParticipantSchema.omit({ bearerToken: true })) }).strict(),
  z.object({ operation: z.literal("initialize"), run: runtimeRunSchema, configuration: z.record(z.string(), z.unknown()), participants: z.array(contextParticipantSchema), mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("bind"), runId: identifierSchema, revision: dynamicContextRevisionSchema, participants: z.array(contextParticipantSchema), mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("freeze"), runId: identifierSchema, roundId: z.number().int().positive(), baseline: dynamicContextRevisionSchema, mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("open_scope"), runId: identifierSchema, roundId: z.number().int().positive(), revision: dynamicContextRevisionSchema, agentId: identifierSchema, principalId: identifierSchema, turnId: identifierSchema, attemptId: identifierSchema }).strict(),
  z.object({ operation: z.literal("close_scope"), runId: identifierSchema, agentId: identifierSchema, scopeId: identifierSchema }).strict(),
  z.object({ operation: z.literal("settlement"), runId: identifierSchema, roundId: z.number().int().positive(), finalFailedTurnIds: z.array(identifierSchema) }).strict(),
  z.object({ operation: z.literal("seal"), runId: identifierSchema, roundId: z.number().int().positive(), baseline: dynamicContextRevisionSchema, readRevision: dynamicContextRevisionSchema, finalFailedTurnIds: z.array(identifierSchema), mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("publish"), runId: identifierSchema, roundId: z.number().int().nonnegative(), candidate: dynamicContextRevisionSchema, mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("fork"), sourceRunId: identifierSchema, sourceRevision: dynamicContextRevisionSchema, targetRun: runtimeRunSchema, configuration: z.record(z.string(), z.unknown()), participants: z.array(contextParticipantSchema), mutation: runtimeMutationSchema }).strict(),
  z.object({ operation: z.literal("revoke"), runId: identifierSchema, mutation: runtimeMutationSchema }).strict(),
]);
export type ContextRuntimeOperation = z.infer<typeof contextRuntimeOperationSchema>;

export const contextRuntimeResultSchema = z.object({
  revision: dynamicContextRevisionSchema.optional(),
  bindings: z.array(contextRuntimeBindingSchema).optional(),
  scope: z.object({ scopeId: identifierSchema, runId: identifierSchema, roundId: z.number().int().nonnegative(), agentId: identifierSchema, principalId: identifierSchema, turnId: identifierSchema, attemptId: identifierSchema, expiresAt: z.string().datetime() }).strict().optional(),
  settlement: z.object({ settled: z.boolean(), pendingCount: z.number().int().nonnegative(), rejectedCount: z.number().int().nonnegative() }).strict().optional(),
  acknowledged: z.boolean().optional(),
}).strict();
export type ContextRuntimeResult = z.infer<typeof contextRuntimeResultSchema>;

export const contextRuntimeMutationSchema = z.object({
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  configuration: z.record(z.string(), z.unknown()).default({}),
  baseline: dynamicContextRevisionSchema.optional(),
  mutation: z.object({
    transitionId: identifierSchema,
    stepId: identifierSchema,
    payloadDigest: digestSchema,
    expectedCheckpointRef: z.string().max(240),
  }).strict(),
}).strict();

export const committedFactQuerySchema = pageInputSchema.extend({ runId: identifierSchema });

export const contextSealSchema = z.object({
  receipt: operationReceiptSchema,
  checkpoint: checkpointSchema,
  state: z.literal("sealed"),
});
export const contextPublishSchema = z.object({
  receipt: operationReceiptSchema,
  checkpoint: checkpointSchema,
  state: z.literal("committed"),
});
