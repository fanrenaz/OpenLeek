import { z } from "zod";
import { digestSchema, identifierSchema } from "./core";

export const socialMcpToolIdSchema = z.enum([
  "social.get_feed",
  "social.get_post",
  "social.list_posts",
  "social.search_posts",
  "social.get_profile",
  "social.list_relationships",
  "social.list_engagements",
  "social.get_notifications",
  "social.get_command_status",
  "social.create_post",
  "social.like_post",
  "social.repost_post",
  "social.reply_to_post",
  "social.follow",
  "social.unfollow",
  "social.engage",
]);
export const financialMcpToolIdSchema = z.enum([
  "financial.get_quote",
  "financial.get_order_book",
  "financial.get_candles",
  "financial.list_market_trades",
  "financial.list_market_orders",
  "financial.get_account",
  "financial.list_orders",
  "financial.list_executions",
  "financial.get_command_status",
  "financial.preview_order",
  "financial.place_order",
  "financial.place_limit_order",
  "financial.place_market_order",
  "financial.replace_order",
  "financial.cancel_order",
]);
export const mcpToolIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/).max(240);
export type McpToolId = z.infer<typeof mcpToolIdSchema>;

export const socialMcpResourceIdSchema = z.enum([
  "social.feed",
  "social.profile",
  "social.posts",
]);
export const financialMcpResourceIdSchema = z.enum([
  "financial.market",
  "financial.account",
  "financial.orders",
]);
export const mcpResourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/).max(240);
export type McpResourceId = z.infer<typeof mcpResourceIdSchema>;

export const mcpPolicyDefinitionSchema = z.object({
  tools: z.array(mcpToolIdSchema).max(100),
  resources: z.array(mcpResourceIdSchema).max(100),
  /** v2 Agent Environment policy. Missing on legacy MCP Policy versions. */
  contexts: z.record(identifierSchema, z.object({
    enabled: z.boolean().default(true),
    accountPolicy: z.record(z.string(), z.unknown()).default({}),
  }).strict()).optional(),
}).strict();
export type McpPolicyDefinition = z.infer<typeof mcpPolicyDefinitionSchema>;

/** A repository-scoped Codex Skill name as declared in SKILL.md frontmatter. */
export const skillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const skillFileSchema = z.object({
  path: z.string().min(1).max(240),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string().max(14_000_000),
  executable: z.boolean().default(false),
}).strict();
export type SkillFile = z.infer<typeof skillFileSchema>;
export const skillRequirementsSchema = mcpPolicyDefinitionSchema;
export type SkillRequirements = z.infer<typeof skillRequirementsSchema>;
export const skillDefinitionSchema = z.object({
  files: z.array(skillFileSchema).min(1).max(200),
  requirements: skillRequirementsSchema.default({ tools: [], resources: [] }),
}).strict();
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export const frozenSkillBindingSchema = z.object({
  versionRef: identifierSchema,
  artifactDigest: digestSchema,
  skillName: skillNameSchema,
}).strict();
export type FrozenSkillBinding = z.infer<typeof frozenSkillBindingSchema>;

export const socialMcpPermissionsSchema = z.object({
  tools: z.array(socialMcpToolIdSchema).max(100),
  resources: z.array(socialMcpResourceIdSchema).max(100),
}).strict();
export type SocialMcpPermissions = z.infer<typeof socialMcpPermissionsSchema>;

export const financialMcpPermissionsSchema = z.object({
  tools: z.array(financialMcpToolIdSchema).max(100),
  resources: z.array(financialMcpResourceIdSchema).max(100),
}).strict();
export type FinancialMcpPermissions = z.infer<typeof financialMcpPermissionsSchema>;


export const agentRuntimeSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("deepseek"),
    model: z.literal("deepseek-v4-flash").default("deepseek-v4-flash"),
    reasoningEffort: z.enum(["high", "xhigh"]).default("high"),
  }).strict(),
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1).max(120),
    reasoningEffort: z.string().min(1).max(32),
  }).strict(),
]);
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

export const agentExecutionSectionSchema = z.object({
  /** Frozen cognition provider for this Run. Credentials remain Runtime-owned. */
  runtime: agentRuntimeSchema.optional(),
  /** Agent-private memory remains independently routed through Hindsight. */
  memoryProfile: z.object({
    routeId: identifierSchema,
    llmConfigRevision: identifierSchema,
  }).strict().optional(),
  maxConcurrentAgents: z.number().int().min(1).max(100).default(10),
  toolCallBudget: z.object({
    /** Per Agent and per Turn. The next Turn starts with fresh counters. */
    maxCallsPerToolPerTurn: z.number().int().min(1).max(100).default(6),
  }).strict().default({ maxCallsPerToolPerTurn: 6 }),
}).strict();
export type AgentExecutionSection = z.infer<typeof agentExecutionSectionSchema>;

/** A published, immutable AGENTS.md artifact owned by Agent Execution. */
export const agentsMdVersionRefSchema = identifierSchema;

export const assetSelectionSchema = z.object({ versionRef: identifierSchema }).strict();
export type AssetSelection = z.infer<typeof assetSelectionSchema>;

export const agentBlueprintDefinitionSchema = z.object({
  agentsMdVersionRef: agentsMdVersionRefSchema,
  mcpPolicyVersionRef: identifierSchema,
  skillVersionRefs: z.array(identifierSchema).max(100).default([]),
}).strict();
export type AgentBlueprintDefinition = z.infer<typeof agentBlueprintDefinitionSchema>;
