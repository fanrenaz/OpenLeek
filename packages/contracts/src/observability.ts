import { z } from "zod";
import { contextRevisionSchema } from "./context";
import { digestSchema, identifierSchema, opaqueCursorSchema } from "./core";
import { candidateActionSchema } from "./experiment";
import { turnPromptVariableValueSchema } from "./turn-prompt";

export const tokenUsageBreakdownSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();

export const tokenAttributedToolCallSchema = z.object({
  callId: identifierSchema,
  name: z.string().min(1).max(500),
  namespace: z.string().min(1).max(500).optional(),
}).strict();

export const actionTokenAttributionSchema = z.object({
  // App Server may report an empty upstream response ID. Preserve that raw
  // attribution value instead of rejecting otherwise valid historical usage.
  responseId: z.string().max(500),
  sequence: z.number().int().nonnegative(),
  classification: z.enum(["mcp_action", "final_response", "batched_actions", "unclassified"]),
  toolCalls: z.array(tokenAttributedToolCallSchema),
  usage: tokenUsageBreakdownSchema.nullable(),
}).strict();

export const toolCallBudgetEvidenceSchema = z.object({
  maxCallsPerToolPerTurn: z.number().int().min(1).max(100),
  counts: z.array(z.object({
    toolName: z.string().min(1).max(500),
    calls: z.number().int().positive(),
  }).strict()),
  termination: z.object({
    reason: z.literal("tool_repeat_budget_exhausted"),
    toolName: z.string().min(1).max(500),
    limit: z.number().int().positive(),
    attemptedCall: z.number().int().positive(),
    toolUseId: z.string().min(1).max(500),
    occurredAt: z.string().datetime(),
  }).strict().optional(),
}).strict();

export const runAgentTurnTokenUsageSchema = z.object({
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  agentId: identifierSchema,
  threadId: identifierSchema,
  turnId: identifierSchema,
  responses: z.array(actionTokenAttributionSchema),
  totals: tokenUsageBreakdownSchema,
  turnCounter: tokenUsageBreakdownSchema.nullable(),
  threadCounter: tokenUsageBreakdownSchema.nullable().optional(),
  modelContextWindow: z.number().int().positive().nullable().optional(),
  compactions: z.array(z.object({
    itemId: z.string().min(1).max(500),
    completedAt: z.string().datetime(),
  }).strict()).optional(),
  toolCallBudget: toolCallBudgetEvidenceSchema.optional(),
  countersMatch: z.boolean().nullable(),
  completeness: z.enum(["complete", "missing_usage", "batched_actions", "missing_usage_and_batched_actions"]),
}).strict();
export const runTokenUsageSchema = z.array(runAgentTurnTokenUsageSchema);

export const executionResultSchema = z.object({
  agentId: identifierSchema,
  candidates: z.array(candidateActionSchema),
  evidenceRef: identifierSchema,
  transcriptRef: identifierSchema.optional(),
  tokenUsage: runAgentTurnTokenUsageSchema
    .omit({ runId: true, roundId: true, agentId: true })
    .optional(),
}).strict();

type TranscriptJsonValue = null | boolean | number | string | TranscriptJsonValue[] | { [key: string]: TranscriptJsonValue };
const transcriptJsonValueSchema = z.custom<TranscriptJsonValue>(isTranscriptJsonValue, "must be a JSON value");

export const agentSessionTranscriptItemSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1).max(240),
  id: z.string().min(1).max(500).optional(),
  payload: z.record(z.string(), transcriptJsonValueSchema),
}).strict();

export const agentSessionTranscriptEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  method: z.string().min(1).max(500),
  payload: transcriptJsonValueSchema,
}).strict();

export const agentSessionTranscriptSchema = z.object({
  schemaVersion: z.literal("1"),
  transcriptRef: identifierSchema,
  digest: digestSchema,
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  agentId: identifierSchema,
  attemptId: identifierSchema,
  orchestrationTurnId: identifierSchema,
  threadId: identifierSchema,
  turnId: identifierSchema,
  session: z.object({
    model: identifierSchema,
    modelProvider: identifierSchema,
    agentsMdVersionRef: identifierSchema,
    agentsMdDigest: digestSchema,
    baseInstructions: z.string(),
    developerInstructions: z.string(),
  }).strict(),
  prompt: z.string(),
  status: z.enum(["completed", "failed", "interrupted"]),
  error: transcriptJsonValueSchema.nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  items: z.array(agentSessionTranscriptItemSchema),
  /**
   * Completed App Server protocol events preserve calls and results that the
   * projected Turn item list does not expose (native resource and Dynamic Tool
   * calls in particular). Optional only so transcripts written before this
   * field was introduced remain readable.
   */
  events: z.array(agentSessionTranscriptEventSchema).optional(),
  tokenUsage: runAgentTurnTokenUsageSchema
    .omit({ runId: true, roundId: true, agentId: true })
    .optional(),
  redactionCount: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
}).strict();

export const agentSessionTranscriptPageSchema = z.object({
  availability: z.enum(["available", "legacy_unavailable"]),
  items: z.array(agentSessionTranscriptSchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict();

export type AgentSessionTranscript = z.infer<typeof agentSessionTranscriptSchema>;
export type AgentSessionTranscriptPage = z.infer<typeof agentSessionTranscriptPageSchema>;

function isTranscriptJsonValue(value: unknown): value is TranscriptJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isTranscriptJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isTranscriptJsonValue);
}

export const committedExecutionSchema = z.object({
  key: z.object({
    runId: identifierSchema,
    roundId: z.number().int().nonnegative(),
    agentId: identifierSchema,
  }).strict(),
  result: executionResultSchema,
}).strict();

export const committedExecutionPageSchema = z.object({
  items: z.array(committedExecutionSchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict();

export const agentRuntimeEvidenceSchema = z.object({
  conditionDigest: digestSchema,
  staticArtifactDigest: digestSchema,
  modelConfiguration: z.object({
    model: identifierSchema,
    configDigest: digestSchema,
  }).strict(),
  turnPrompt: z.object({
    versionRef: identifierSchema,
    artifactDigest: digestSchema,
    variables: z.record(z.string(), turnPromptVariableValueSchema),
  }).strict(),
  instructionPolicy: z.object({
    version: z.string().min(1).max(240),
    baseInstructionsDigest: z.string().min(1).max(240),
    environmentContextDigest: z.string().min(1).max(240),
    nativeEnvironmentContext: z.boolean().nullable(),
    hostCurrentDateExposed: z.boolean().nullable(),
  }).strict(),
  contextCompaction: z.object({
    policy: z.object({
      mode: z.enum(["auto", "model-default"]),
      tokenLimit: z.number().int().positive().nullable(),
      scope: z.enum(["total", "body_after_prefix"]).nullable(),
      prompt: z.literal("codex-default"),
    }).strict(),
    events: z.array(z.object({
      runId: identifierSchema,
      roundId: z.number().int().nonnegative(),
      agentId: identifierSchema,
      threadId: identifierSchema,
      turnId: identifierSchema,
      itemId: z.string().min(1).max(500),
      trigger: z.literal("auto"),
      completedAt: z.string().datetime(),
    }).strict()),
  }).strict(),
  toolCallBudget: z.object({
    policy: z.object({
      maxCallsPerToolPerTurn: z.number().int().min(1).max(100),
    }).strict(),
    exhaustionEvents: z.array(z.object({
      runId: identifierSchema,
      roundId: z.number().int().nonnegative(),
      agentId: identifierSchema,
      threadId: identifierSchema,
      turnId: identifierSchema,
      reason: z.literal("tool_repeat_budget_exhausted"),
      toolName: z.string().min(1).max(500),
      limit: z.number().int().positive(),
      attemptedCall: z.number().int().positive(),
      toolUseId: z.string().min(1).max(500),
      occurredAt: z.string().datetime(),
    }).strict()),
  }).strict().optional(),
  artifacts: z.array(z.object({
    agentId: identifierSchema,
    conditionDigest: digestSchema,
    manifestDigest: digestSchema,
  }).strict()),
  driftEvents: z.array(z.object({
    runId: identifierSchema,
    agentId: identifierSchema,
    roundId: z.number().int().nonnegative(),
    phase: z.enum(["before_turn", "after_turn"]),
    detectedAt: z.string().datetime(),
    expectedDigest: digestSchema,
    observedDigest: digestSchema,
    restored: z.literal(true),
  }).strict()),
  instructionPolicyMigrations: z.array(z.object({
    from: z.literal("legacy-model-catalog"),
    to: z.string().min(1).max(240),
    checkpointRef: identifierSchema,
    migratedAt: z.string().datetime(),
  }).strict()),
  sandbox: z.object({
    state: z.enum(["active", "released", "unavailable"]),
    restartCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime().optional(),
    releasedAt: z.string().datetime().optional(),
  }).strict(),
}).strict();

const socialPostSchema = z.object({
  postId: identifierSchema,
  authorId: identifierSchema,
  content: z.string(),
  headline: z.string(),
  roundId: z.number().int().nonnegative(),
  postType: z.enum(["original", "repost", "reply"]).optional(),
  parentPostId: identifierSchema.optional(),
}).strict();
const socialExposureSchema = z.object({
  exposureId: identifierSchema,
  actorId: identifierSchema,
  postId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  rank: z.number().int().nonnegative(),
}).strict();
const socialEngagementSchema = z.object({
  engagementId: identifierSchema,
  actorId: identifierSchema,
  targetPostId: identifierSchema,
  kind: z.enum(["like", "repost", "reply"]),
  replyBody: z.string().optional(),
  derivedPostId: identifierSchema.optional(),
  roundId: z.number().int().nonnegative(),
}).strict();
const socialRelationshipSchema = z.object({
  actorId: identifierSchema,
  targetActorId: identifierSchema,
}).strict();
const audienceReceptionSchema = z.object({
  postId: identifierSchema,
  exposureCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  repostCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
}).strict();
export const socialCommittedFactsSchema = z.object({
  posts: z.array(socialPostSchema),
  exposures: z.array(socialExposureSchema),
  engagements: z.array(socialEngagementSchema),
  relationships: z.array(socialRelationshipSchema),
  summary: z.object({
    roundId: z.number().int().nonnegative(),
    postCount: z.number().int().nonnegative(),
    exposureCount: z.number().int().nonnegative(),
    engagementCount: z.number().int().nonnegative(),
    audienceReception: z.array(audienceReceptionSchema),
  }).strict(),
}).strict();

export const marketSummarySchema = z.object({
  roundId: z.number().int().nonnegative(),
  lastTradePrice: z.number().finite().nonnegative(),
  volume: z.number().int().nonnegative(),
  bestBid: z.number().finite().nonnegative(),
  bestAsk: z.number().finite().nonnegative(),
  openOrderCount: z.number().int().nonnegative(),
}).strict();
export const tradeSchema = z.object({
  tradeId: identifierSchema,
  buyOrderId: identifierSchema,
  sellOrderId: identifierSchema,
  quantity: z.number().int().positive(),
  price: z.number().finite().positive(),
  roundId: z.number().int().positive(),
}).strict();
export const financialCommittedFactsSchema = z.object({
  revision: contextRevisionSchema,
  tickSize: z.number().finite().positive(),
  trades: z.array(tradeSchema),
  summary: marketSummarySchema,
}).strict();
