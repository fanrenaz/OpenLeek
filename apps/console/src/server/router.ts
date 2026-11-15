import { agentBlueprintDefinitionSchema, mcpPolicyDefinitionSchema, skillDefinitionSchema } from "@openleek/contracts/agent";
import { contextAssetCommandSchema, contextAssetReadSchema } from "@openleek/contracts/context";
import { dataDictionaryCatalogSchema } from "@openleek/contracts/data-dictionary";
import { identifierSchema, pageInputSchema } from "@openleek/contracts/core";
import { pluginSpecificationSchema, pluginManifestSchema, runLifecycleSchema } from "@openleek/contracts/experiment";
import { turnPromptSelectionSchema, turnPromptVariableDefinitionSchema, turnPromptVariableValueSchema } from "@openleek/contracts/turn-prompt";
import { financialInitialStatePresetDefinitionSchema, populationEntrySchema } from "@openleek/contracts/world";
import { sha256Digest } from "@openleek/contracts/canonical";
import { domainProcedure, t } from "@openleek/trpc";
import Ajv from "ajv";
import { z } from "zod";
import type { ConsolePorts } from "./ports";
import { networkConsolePorts } from "./ports";
import { llmConfigurationCapability, sanitizeLlmConfigurationForBrowser } from "./llm-configuration-projection";

const commandSchema = z.object({ runId: identifierSchema, expectedManifestRef: z.string().max(240), idempotencyKey: identifierSchema });
const factInputSchema = z.object({ runId: identifierSchema, manifestRef: identifierSchema.optional() }).merge(pageInputSchema);
const sandboxAuditSchema = z.object({
  state: z.enum(["active", "released", "unavailable"]),
  restartCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime().optional(),
  releasedAt: z.string().datetime().optional(),
});
const configResourceIdentifierSchema = z.string().min(1).max(240);
const configChangeSchema = z.object({
  kind: configResourceIdentifierSchema,
  id: configResourceIdentifierSchema,
  field: configResourceIdentifierSchema,
  value: z.unknown(),
}).strict();
const configPatchSchema = z.object({
  baseRevision: configResourceIdentifierSchema,
  changes: z.array(configChangeSchema).min(1).max(500),
}).strict();
const createConfigResourceSchema = z.object({
  kind: configResourceIdentifierSchema,
  id: configResourceIdentifierSchema,
  baseRevision: configResourceIdentifierSchema,
  value: z.record(z.string(), z.unknown()).default({}),
}).strict();
const deleteConfigResourceSchema = z.object({
  kind: configResourceIdentifierSchema,
  id: configResourceIdentifierSchema,
  baseRevision: configResourceIdentifierSchema,
}).strict();
const feedAlgorithmLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().min(1).max(60_000).default(60_000),
  maxMemoryMb: z.number().int().min(64).max(1_024).default(1_024),
}).strict();
const feedAlgorithmDraftSchema = z.object({
  algorithmId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
  source: z.string().min(1).max(250_000),
  defaultConfig: z.record(z.string(), z.unknown()).default({}),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.enum(["numpy", "networkx", "scipy", "pandas", "sklearn"])).max(5).default([]),
  limits: feedAlgorithmLimitsSchema.default({ maxRuntimeMs: 60_000, maxMemoryMb: 1_024 }),
}).strict();
const feedAlgorithmPreviewSchema = z.object({
  versionRef: identifierSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  runId: identifierSchema,
  revisionRef: identifierSchema,
  seed: z.string().min(1).max(240),
}).strict();
const marketMakerDraftSchema = feedAlgorithmDraftSchema;
const marketMakerPreviewSchema = z.object({
  versionRef: identifierSchema,
  config: z.record(z.string(), z.unknown()).default({}),
  runId: identifierSchema,
  revisionRef: identifierSchema,
  seed: z.string().min(1).max(240),
  accountId: identifierSchema,
  timing: z.enum(["opening", "settlement"]),
}).strict();
const agentsMdDraftSchema = z.object({
  templateId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
  source: z.string().min(1).max(250_000),
}).strict();
const turnPromptDraftSchema = z.object({ promptId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), source: z.string().min(1).max(100_000), variables: z.array(turnPromptVariableDefinitionSchema).max(100) }).strict();
const generatorLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().min(1).max(60_000).default(60_000),
  maxMemoryMb: z.number().int().min(64).max(1_024).default(1_024),
}).strict();
const dictionaryAjv = new Ajv({ allErrors: true, strict: false });

export function header(idempotencyKey: string, stepId: string, expectedCheckpointRef: string, body: unknown) {
  return {
    transitionId: idempotencyKey,
    stepId,
    expectedCheckpointRef,
    payloadDigest: sha256Digest(body),
  };
}

function algorithmPort<T extends keyof Pick<ConsolePorts, "feedAlgorithms" | "feedAlgorithmDraft" | "feedAlgorithmVersion" | "saveFeedAlgorithmDraft" | "validateFeedAlgorithm" | "publishFeedAlgorithm" | "previewFeedAlgorithm">>(ports: ConsolePorts, name: T): NonNullable<ConsolePorts[T]> {
  const port = ports[name];
  if (!port) throw new Error(`Console feed algorithm port ${name} is unavailable`);
  return port as NonNullable<ConsolePorts[T]>;
}

function marketMakerPort<T extends keyof Pick<ConsolePorts, "marketMakers" | "marketMakerDraft" | "marketMakerVersion" | "saveMarketMakerDraft" | "validateMarketMaker" | "publishMarketMaker" | "previewMarketMaker">>(ports: ConsolePorts, name: T): NonNullable<ConsolePorts[T]> {
  const port = ports[name];
  if (!port) throw new Error(`Console market maker port ${name} is unavailable`);
  return port as NonNullable<ConsolePorts[T]>;
}
function agentsMdPort<T extends keyof Pick<ConsolePorts, "agentsMd" | "agentsMdDraft" | "agentsMdVersion" | "saveAgentsMdDraft" | "publishAgentsMd">>(ports: ConsolePorts, name: T): NonNullable<ConsolePorts[T]> {
  const port = ports[name];
  if (!port) throw new Error(`Console AGENTS.md port ${name} is unavailable`);
  return port as NonNullable<ConsolePorts[T]>;
}

/** Browser-facing router. It composes Context responses but owns no facts. */
export function createConsoleRouter(ports: ConsolePorts = networkConsolePorts()) {
  return t.router({
    console: t.router({
      dataDictionary: t.router({
        catalog: domainProcedure
          .input(z.object({}).strict())
          .output(dataDictionaryCatalogSchema)
          .query(async () => {
            if (!ports.dataDictionaryCatalog) {
              return { schemaVersion: "1" as const, sources: [] };
            }
            const catalog = dataDictionaryCatalogSchema.parse(await ports.dataDictionaryCatalog());
            for (const source of catalog.sources) {
              for (const entry of source.entries) {
                const validate = dictionaryAjv.compile(entry.definitionSchema);
                for (const example of entry.examples) {
                  if (!validate(example.value)) {
                    throw new Error(`Data dictionary example is invalid for ${entry.id}: ${dictionaryAjv.errorsText(validate.errors)}`);
                  }
                }
                if (entry.programming) {
                  dictionaryAjv.compile(entry.programming.contextSchema);
                  dictionaryAjv.compile(entry.programming.resultSchema);
                }
              }
            }
            return catalog;
          }),
      }),
      runs: domainProcedure.input(pageInputSchema.extend({ lifecycle: runLifecycleSchema.optional() })).query(({ input }) => ports.listRuns(input)),
      contexts: t.router({
        catalog: domainProcedure.input(z.object({}).strict()).query(() => ports.contextCatalog()),
        assetRead: domainProcedure.input(contextAssetReadSchema).query(({ input }) => ports.contextAssetRead(input)),
        assetCommand: domainProcedure.input(contextAssetCommandSchema).mutation(({ input }) => ports.contextAssetCommand(input)),
      }),
      specification: domainProcedure.input(z.object({ specification: z.unknown() })).query(({ input }) => ports.validateSpecification(input)),
      runtimeCapability: domainProcedure.input(z.object({})).query(async () => {
        const [runtime, providers, memory] = await Promise.all([
          ports.agentRuntimeCapability({}),
          ports.agentExecutionProviders?.({}) ?? Promise.resolve(undefined),
          ports.llmConfigGraph().then(llmConfigurationCapability),
        ]);
        return { ...asRecord(runtime), ...(providers === undefined ? {} : asRecord(providers)), revision: memory.revision, memoryRoute: memory.memoryRoute };
      }),
      executionProviders: domainProcedure.input(z.object({}).strict()).query(() => requiredPort(ports.agentExecutionProviders, "execution providers")({})),
      chatGptAuth: t.router({
        status: domainProcedure.input(z.object({}).strict()).query(() => requiredPort(ports.chatGptAuthStatus, "ChatGPT authorization")({})),
        rateLimits: domainProcedure.input(z.object({}).strict()).query(() => requiredPort(ports.chatGptRateLimits, "ChatGPT rate limits")({})),
        startDeviceAuthorization: domainProcedure.input(z.object({}).strict()).mutation(() => requiredPort(ports.startChatGptDeviceAuthorization, "ChatGPT authorization")({})),
        cancelDeviceAuthorization: domainProcedure.input(z.object({}).strict()).mutation(() => requiredPort(ports.cancelChatGptDeviceAuthorization, "ChatGPT authorization")({})),
        logout: domainProcedure.input(z.object({}).strict()).mutation(() => requiredPort(ports.logoutChatGpt, "ChatGPT authorization")({})),
      }),
      createRun: domainProcedure.input(z.object({ idempotencyKey: identifierSchema, specification: z.unknown() })).mutation(async ({ input }) => {
        const capability = llmConfigurationCapability(await ports.llmConfigGraph());
        const original = input.specification as unknown as Record<string, unknown>;
        const agentExecution = asRecord(original.agentExecution);
        // LLM Configuration remains authoritative only for Hindsight memory.
        const specification = pluginSpecificationSchema.parse({
          ...original,
          agentExecution: {
            ...agentExecution,
            memoryProfile: { routeId: capability.memoryRoute, llmConfigRevision: capability.revision },
          },
        });
        const mutation = header(input.idempotencyKey, "create", "", specification);
        return ports.createRun({ mutation, specification });
      }),
      llmConfiguration: t.router({
        graph: domainProcedure.input(z.object({})).query(async () => sanitizeLlmConfigurationForBrowser(await ports.llmConfigGraph())),
        capability: domainProcedure.input(z.object({})).query(async () => llmConfigurationCapability(await ports.llmConfigGraph())),
        validate: domainProcedure.input(configPatchSchema).mutation(async ({ input }) => sanitizeLlmConfigurationForBrowser(await ports.llmConfigValidate(input))),
        patch: domainProcedure.input(configPatchSchema).mutation(async ({ input }) => sanitizeLlmConfigurationForBrowser(await ports.llmConfigPatch(input))),
        createResource: domainProcedure.input(createConfigResourceSchema).mutation(async ({ input }) => {
          const { kind, ...body } = input;
          return sanitizeLlmConfigurationForBrowser(await ports.llmConfigCreateResource(kind, body));
        }),
        deleteResource: domainProcedure.input(deleteConfigResourceSchema).mutation(async ({ input }) => {
          return sanitizeLlmConfigurationForBrowser(await ports.llmConfigDeleteResource(input.kind, input.id, input.baseRevision));
        }),
      }),
      agentsMd: t.router({
        list: domainProcedure.input(z.object({})).query(() => agentsMdPort(ports, "agentsMd")()),
        draft: domainProcedure.input(z.object({ templateId: identifierSchema })).query(({ input }) => agentsMdPort(ports, "agentsMdDraft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => agentsMdPort(ports, "agentsMdVersion")(input)),
        saveDraft: domainProcedure.input(agentsMdDraftSchema).mutation(({ input }) => agentsMdPort(ports, "saveAgentsMdDraft")(input)),
        publish: domainProcedure.input(z.object({ templateId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => agentsMdPort(ports, "publishAgentsMd")(input)),
      }),
      turnPrompts: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.turnPrompts, "turn prompts")()),
        draft: domainProcedure.input(z.object({ promptId: identifierSchema })).query(({ input }) => requiredPort(ports.turnPromptDraft, "turn prompt draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.turnPromptVersion, "turn prompt version")(input)),
        saveDraft: domainProcedure.input(turnPromptDraftSchema).mutation(({ input }) => requiredPort(ports.saveTurnPromptDraft, "save turn prompt")(input)),
        validate: domainProcedure.input(z.object({ source: z.string().min(1).max(100_000), variables: z.array(turnPromptVariableDefinitionSchema).max(100) }).strict()).mutation(({ input }) => requiredPort(ports.validateTurnPrompt, "validate turn prompt")(input)),
        preview: domainProcedure.input(z.object({ source: z.string().min(1).max(100_000), definitions: z.array(turnPromptVariableDefinitionSchema).max(100), variables: z.record(z.string(), turnPromptVariableValueSchema), utcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), roundId: z.number().int().nonnegative() }).strict()).mutation(({ input }) => requiredPort(ports.previewTurnPrompt, "preview turn prompt")(input)),
        publish: domainProcedure.input(z.object({ promptId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishTurnPrompt, "publish turn prompt")(input)),
      }),
      mcpPolicies: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.mcpPolicies, "MCP Policies")()),
        draft: domainProcedure.input(z.object({ policyId: identifierSchema })).query(({ input }) => requiredPort(ports.mcpPolicyDraft, "MCP Policy draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.mcpPolicyVersion, "MCP Policy version")(input)),
        saveDraft: domainProcedure.input(z.object({
          policyId: identifierSchema.optional(),
          expectedRevision: z.number().int().positive().optional(),
          name: z.string().min(1).max(240),
          tools: mcpPolicyDefinitionSchema.shape.tools,
          resources: mcpPolicyDefinitionSchema.shape.resources,
          contexts: mcpPolicyDefinitionSchema.shape.contexts,
        }).strict()).mutation(({ input }) => requiredPort(ports.saveMcpPolicyDraft, "save MCP Policy")(input)),
        publish: domainProcedure.input(z.object({ policyId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishMcpPolicy, "publish MCP Policy")(input)),
      }),
      skills: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.skills, "Skills")()),
        draft: domainProcedure.input(z.object({ skillId: identifierSchema })).query(({ input }) => requiredPort(ports.skillDraft, "Skill draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.skillVersion, "Skill version")(input)),
        validate: domainProcedure.input(skillDefinitionSchema).mutation(({ input }) => requiredPort(ports.validateSkill, "validate Skill")(input)),
        saveDraft: domainProcedure.input(skillDefinitionSchema.extend({
          skillId: identifierSchema.optional(),
          expectedRevision: z.number().int().positive().optional(),
          name: z.string().min(1).max(240),
        }).strict()).mutation(({ input }) => requiredPort(ports.saveSkillDraft, "save Skill")(input)),
        publish: domainProcedure.input(z.object({ skillId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishSkill, "publish Skill")(input)),
      }),
      populations: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.populations, "populations")()),
        draft: domainProcedure.input(z.object({ populationId: identifierSchema })).query(({ input }) => requiredPort(ports.populationDraft, "population draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.populationVersion, "population version")(input)),
        saveDraft: domainProcedure.input(z.object({ populationId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), entries: z.array(populationEntrySchema).min(1).max(1_000) }).strict()).mutation(({ input }) => requiredPort(ports.savePopulationDraft, "save population")(input)),
        publish: domainProcedure.input(z.object({ populationId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishPopulation, "publish population")(input)),
      }),
      agentBlueprints: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.agentBlueprints, "agent blueprints")()),
        draft: domainProcedure.input(z.object({ blueprintId: identifierSchema })).query(({ input }) => requiredPort(ports.agentBlueprintDraft, "agent blueprint draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.agentBlueprintVersion, "agent blueprint version")(input)),
        saveDraft: domainProcedure.input(z.object({ blueprintId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1), definition: agentBlueprintDefinitionSchema }).strict()).mutation(({ input }) => requiredPort(ports.saveAgentBlueprintDraft, "save agent blueprint")(input)),
        publish: domainProcedure.input(z.object({ blueprintId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishAgentBlueprint, "publish agent blueprint")(input)),
      }),
      financialInitialStatePresets: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.financialInitialStatePresets, "financial initial state presets")()),
        draft: domainProcedure.input(z.object({ presetId: identifierSchema })).query(({ input }) => requiredPort(ports.financialInitialStatePresetDraft, "financial initial state preset draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.financialInitialStatePresetVersion, "financial initial state preset version")(input)),
        saveDraft: domainProcedure.input(z.union([
          z.object({ presetId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1), definition: financialInitialStatePresetDefinitionSchema }).strict(),
          z.object({ presetId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1), cash: z.number().finite().nonnegative(), positions: z.record(z.string(), z.number().finite().nonnegative()).default({}) }).strict(),
        ])).mutation(({ input }) => requiredPort(ports.saveFinancialInitialStatePresetDraft, "save financial initial state preset")(input)),
        publish: domainProcedure.input(z.object({ presetId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishFinancialInitialStatePreset, "publish financial initial state preset")(input)),
      }),
      socialNetworks: t.router({
        list: domainProcedure.input(z.object({})).query(() => requiredPort(ports.socialNetworks, "social networks")()),
        draft: domainProcedure.input(z.object({ networkId: identifierSchema })).query(({ input }) => requiredPort(ports.socialNetworkDraft, "social network draft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => requiredPort(ports.socialNetworkVersion, "social network version")(input)),
        saveDraft: domainProcedure.input(z.object({ networkId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1), source: z.string().min(1), defaultConfig: z.record(z.string(), z.unknown()).default({}), configSchema: z.record(z.string(), z.unknown()).optional(), dependencies: z.array(z.string()).max(5).optional(), limits: generatorLimitsSchema.optional() }).strict()).mutation(({ input }) => requiredPort(ports.saveSocialNetworkDraft, "save social network")(input)),
        validate: domainProcedure.input(z.object({ networkId: identifierSchema, source: z.string().optional(), dependencies: z.array(z.string()).optional(), limits: generatorLimitsSchema.optional() }).strict()).mutation(({ input }) => requiredPort(ports.validateSocialNetwork, "validate social network")(input)),
        publish: domainProcedure.input(z.object({ networkId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => requiredPort(ports.publishSocialNetwork, "publish social network")(input)),
      }),
      feedAlgorithms: t.router({
        list: domainProcedure.input(z.object({})).query(() => algorithmPort(ports, "feedAlgorithms")()),
        draft: domainProcedure.input(z.object({ algorithmId: identifierSchema })).query(({ input }) => algorithmPort(ports, "feedAlgorithmDraft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => algorithmPort(ports, "feedAlgorithmVersion")(input)),
        saveDraft: domainProcedure.input(feedAlgorithmDraftSchema).mutation(({ input }) => algorithmPort(ports, "saveFeedAlgorithmDraft")(input)),
        validate: domainProcedure.input(z.object({
          algorithmId: identifierSchema,
          source: z.string().min(1).max(250_000).optional(),
          dependencies: z.array(z.enum(["numpy", "networkx", "scipy", "pandas", "scikit-learn"])).max(5).optional(),
          limits: feedAlgorithmLimitsSchema.optional(),
        }).strict()).mutation(({ input }) => algorithmPort(ports, "validateFeedAlgorithm")(input)),
        publish: domainProcedure.input(z.object({ algorithmId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => algorithmPort(ports, "publishFeedAlgorithm")(input)),
        preview: domainProcedure.input(feedAlgorithmPreviewSchema).mutation(({ input }) => algorithmPort(ports, "previewFeedAlgorithm")(input)),
      }),
      marketMakers: t.router({
        list: domainProcedure.input(z.object({})).query(() => marketMakerPort(ports, "marketMakers")()),
        draft: domainProcedure.input(z.object({ algorithmId: identifierSchema })).query(({ input }) => marketMakerPort(ports, "marketMakerDraft")(input)),
        version: domainProcedure.input(z.object({ versionRef: identifierSchema })).query(({ input }) => marketMakerPort(ports, "marketMakerVersion")(input)),
        saveDraft: domainProcedure.input(marketMakerDraftSchema).mutation(({ input }) => marketMakerPort(ports, "saveMarketMakerDraft")(input)),
        validate: domainProcedure.input(z.object({
          algorithmId: identifierSchema,
          source: z.string().min(1).max(250_000).optional(),
          dependencies: z.array(z.enum(["numpy", "networkx", "scipy", "pandas", "scikit-learn"])).max(5).optional(),
          limits: feedAlgorithmLimitsSchema.optional(),
        }).strict()).mutation(({ input }) => marketMakerPort(ports, "validateMarketMaker")(input)),
        publish: domainProcedure.input(z.object({ algorithmId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => marketMakerPort(ports, "publishMarketMaker")(input)),
        preview: domainProcedure.input(marketMakerPreviewSchema).mutation(({ input }) => marketMakerPort(ports, "previewMarketMaker")(input)),
      }),
      cancel: domainProcedure.input(commandSchema).mutation(({ input }) => ports.command("cancel", {
        runId: input.runId,
        mutation: header(input.idempotencyKey, "cancel", input.expectedManifestRef, { runId: input.runId, expectedManifestRef: input.expectedManifestRef }),
      })),
      retry: domainProcedure.input(commandSchema).mutation(({ input }) => ports.command("retry", {
        runId: input.runId,
        mutation: header(input.idempotencyKey, "retry", input.expectedManifestRef, { runId: input.runId, expectedManifestRef: input.expectedManifestRef }),
      })),
      resume: domainProcedure.input(commandSchema).mutation(({ input }) => ports.command("resume", {
        runId: input.runId,
        mutation: header(input.idempotencyKey, "resume", input.expectedManifestRef, { runId: input.runId, expectedManifestRef: input.expectedManifestRef }),
      })),
      fork: domainProcedure.input(commandSchema.extend({
        sourceManifestRef: identifierSchema,
        contextConfigurations: z.record(identifierSchema, z.record(z.string(), z.unknown())).default({}),
        agentsMdByAgentId: z.record(identifierSchema, identifierSchema).default({}),
        turnPrompt: turnPromptSelectionSchema.optional(),
      })).mutation(({ input }) => ports.fork({
        sourceRunId: input.runId,
        sourceManifestRef: input.sourceManifestRef,
        contextConfigurations: input.contextConfigurations,
        ...(Object.keys(input.agentsMdByAgentId).length ? { agentsMdByAgentId: input.agentsMdByAgentId } : {}),
        ...(input.turnPrompt === undefined ? {} : { turnPrompt: input.turnPrompt }),
        mutation: header(input.idempotencyKey, "fork", input.expectedManifestRef, {
          sourceRunId: input.runId,
          sourceManifestRef: input.sourceManifestRef,
          contextConfigurations: input.contextConfigurations,
          ...(Object.keys(input.agentsMdByAgentId).length ? { agentsMdByAgentId: input.agentsMdByAgentId } : {}),
          ...(input.turnPrompt === undefined ? {} : { turnPrompt: input.turnPrompt }),
        }),
      })),
      run: domainProcedure.input(z.object({ runId: identifierSchema })).query(({ input }) => ports.getRun(input)),
      audit: domainProcedure.input(z.object({ runId: identifierSchema })).query(async ({ input }) => {
        const [run, agentExecution, registrations] = await Promise.all([
          ports.getRun(input),
          ports.agentRuntimeEvidence(input),
          ports.agentRegistrations(input),
        ]);
        return { run, agentExecution: auditRuntimeEvidence(agentExecution), registrations };
      }),
      tokenUsage: domainProcedure.input(z.object({ runId: identifierSchema })).query(({ input }) => ports.agentTokenUsage(input)),
      transcripts: domainProcedure.input(z.object({
        runId: identifierSchema,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
        agentId: identifierSchema.optional(),
        roundId: z.number().int().nonnegative().optional(),
        attemptId: identifierSchema.optional(),
        turnId: identifierSchema.optional(),
      }).strict()).query(({ input }) => requiredPort(ports.agentTranscripts, "Agent transcript")(input)),
      hookPolicy: domainProcedure.input(z.object({ runId: identifierSchema }).strict()).query(({ input }) => ports.agentHookPolicy(input)),
      updateHookPolicy: domainProcedure.input(z.object({
        runId: identifierSchema,
        strategyInjectionEnabled: z.boolean(),
        expectedRevision: z.number().int().positive(),
        idempotencyKey: identifierSchema,
      }).strict()).mutation(({ input }) => ports.updateAgentHookPolicy(input)),
      roundProgress: domainProcedure.input(z.object({ runId: identifierSchema })).query(({ input }) => ports.roundProgress(input)),
      committedRounds: domainProcedure.input(z.object({ runId: identifierSchema }).merge(pageInputSchema)).query(({ input }) => ports.committedRounds(input)),
      artifacts: domainProcedure.input(z.object({ runId: identifierSchema }).merge(pageInputSchema)).query(async ({ input }) => {
        const result = await ports.committedRounds(input);
        return { kind: "committed-manifest", ...asRecord(result) };
      }),
      facts: domainProcedure.input(factInputSchema).query(async ({ input }) => {
        const manifest = pluginManifestSchema.parse(await ports.committedManifest({ runId: input.runId, manifestRef: input.manifestRef }));
        const agentExecution = await ports.committedFacts("agentExecution", { runId: input.runId, cursor: input.cursor, limit: input.limit });
        return { manifest, agentExecution, contexts: manifest.contexts };
      }),
      analysis: domainProcedure.input(factInputSchema).query(async ({ input }) => {
        const manifest = pluginManifestSchema.parse(await ports.committedManifest({ runId: input.runId, manifestRef: input.manifestRef }));
        const agentExecution = await ports.committedFacts("agentExecution", { runId: input.runId, cursor: input.cursor, limit: input.limit });
        return { runId: input.runId, manifestRef: manifest.ref, committedOnly: true, sources: ["agentExecution", ...Object.keys(manifest.contexts).sort()], itemCounts: [itemCount(agentExecution), ...Object.keys(manifest.contexts).sort().map(() => 1)] };
      }),
    }),
  });
}

let runtimeRouter: ReturnType<typeof createConsoleRouter> | undefined;
export function getConsoleRouter() { runtimeRouter ??= createConsoleRouter(); return runtimeRouter; }
export type ConsoleRouter = ReturnType<typeof createConsoleRouter>;

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function requiredPort<T extends (...args: never[]) => unknown>(port: T | undefined, name: string): T { if (!port) throw new Error(`Console ${name} port is unavailable`); return port; }

/**
 * Console's audit API is the only browser projection of Agent Execution
 * runtime evidence. Sandbox identity and connectivity values are deliberately
 * excluded: the browser gets lifecycle state, retry generation and timestamps
 * only. `sandboxSummary` remains a short-lived compatibility read while Agent
 * Execution publishes the locked `sandbox` field.
 */
export function auditRuntimeEvidence(value: unknown): Record<string, unknown> {
  const evidence = asRecord(value);
  const result: Record<string, unknown> = {};
  for (const key of ["conditionDigest", "staticArtifactDigest", "modelConfiguration", "turnPrompt", "instructionPolicy", "contextCompaction", "instructionPolicyMigrations", "artifacts", "driftEvents"] as const) {
    if (key in evidence) result[key] = evidence[key];
  }
  const sandbox = sandboxAuditSchema.safeParse(evidence.sandbox ?? evidence.sandboxSummary);
  if (sandbox.success) result.sandbox = sandbox.data;
  return result;
}
function itemCount(value: unknown): number { const record = asRecord(value); return Array.isArray(record.items) ? record.items.length : Array.isArray(record.facts) ? record.facts.length : 0; }
