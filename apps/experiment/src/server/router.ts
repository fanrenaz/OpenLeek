import { agentBlueprintDefinitionSchema } from "@openleek/contracts/agent";
import { deleteDraftInputSchema, deleteVersionInputSchema } from "@openleek/contracts/assets";
import { contextAssetCommandSchema, contextAssetReadSchema } from "@openleek/contracts/context";
import { dataDictionarySourceSchema } from "@openleek/contracts/data-dictionary";
import { identifierSchema, pageInputSchema } from "@openleek/contracts/core";
import {
  committedPluginManifestSchema,
  committedPluginRoundListSchema,
  createRunInputSchema,
  forkRunInputSchema,
  roundProgressSchema,
  runCommandInputSchema,
  runLifecycleSchema,
  runListResultSchema,
} from "@openleek/contracts/experiment";
import { turnPromptVariableDefinitionSchema, turnPromptVariableValueSchema } from "@openleek/contracts/turn-prompt";
import { populationEntrySchema } from "@openleek/contracts/world";
import { domainProcedure, t } from "@openleek/trpc";
import { z } from "zod";
import { contextAssetCommand, contextAssetRead, contextCatalog, experimentService } from "./runtime";
import { experimentDataDictionary } from "./data-dictionary";

const service = () => experimentService();

export const experimentRouter = t.router({
  experiment: t.router({
    dataDictionary: t.router({
      catalog: domainProcedure
        .input(z.object({}).strict())
        .output(dataDictionarySourceSchema)
        .query(() => experimentDataDictionary),
    }),
    contexts: t.router({
      catalog: domainProcedure.input(z.object({}).strict()).query(() => contextCatalog()),
      assetRead: domainProcedure.input(contextAssetReadSchema).query(({ input }) => contextAssetRead(input)),
      assetCommand: domainProcedure.input(contextAssetCommandSchema).mutation(({ input }) => contextAssetCommand(input)),
    }),
    researchTemplates: t.router({
      list: domainProcedure.input(z.object({}).strict()).query(() => service().then((instance) => instance.listResearchTemplates())),
      version: domainProcedure.input(z.object({ versionRef: identifierSchema }).strict()).query(({ input }) => service().then((instance) => instance.researchTemplateVersion(input.versionRef))),
    }),
    validateSpecification: domainProcedure.input(z.object({ specification: z.unknown() })).query(async ({ input }) => service().then((instance) => instance.validateSpecificationV2(input.specification))),
    create: domainProcedure.input(createRunInputSchema).mutation(async ({ input }) => service().then((instance) => instance.createRun(input))),
    list: domainProcedure.input(pageInputSchema.extend({ lifecycle: runLifecycleSchema.optional() })).output(runListResultSchema).query(async ({ input }) => service().then((instance) => instance.listRuns(input))),
    get: domainProcedure.input(z.object({ runId: identifierSchema })).query(async ({ input }) => service().then((instance) => instance.getRun(input.runId))),
    agentRegistrations: domainProcedure.input(z.object({ runId: identifierSchema })).query(async ({ input }) => service().then(async (instance) => ({ registrations: await instance.agentRegistrations(input.runId) }))),
    roundProgress: domainProcedure.input(z.object({ runId: identifierSchema })).output(roundProgressSchema.optional()).query(async ({ input }) => service().then((instance) => instance.roundProgress(input.runId))),
    cancel: domainProcedure.input(runCommandInputSchema).mutation(async ({ input }) => service().then((instance) => instance.cancelRun(input))),
    retry: domainProcedure.input(runCommandInputSchema).mutation(async ({ input }) => service().then((instance) => instance.retryRun(input))),
    resume: domainProcedure.input(runCommandInputSchema).mutation(async ({ input }) => service().then((instance) => instance.resumeRun(input))),
    fork: domainProcedure.input(forkRunInputSchema).mutation(async ({ input }) => service().then((instance) => instance.forkRun({
      sourceRunId: input.sourceRunId,
      sourceManifestRef: input.sourceManifestRef,
      mutation: input.mutation,
      agentsMdByAgentId: input.agentsMdByAgentId,
      contextConfigurations: input.contextConfigurations,
      ...(input.turnPrompt === undefined ? {} : { turnPrompt: input.turnPrompt }),
    }))),
    populations: t.router({
      list: domainProcedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.listPopulations(input.includeDeleted))),
      draft: domainProcedure.input(z.object({ populationId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getPopulationDraft(input.populationId, input.includeDeleted))),
      version: domainProcedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getPopulationVersion(input.versionRef, input.includeDeleted))),
      saveDraft: domainProcedure.input(z.object({ populationId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), entries: z.array(populationEntrySchema).min(1).max(1_000) }).strict()).mutation(({ input }) => service().then((instance) => instance.savePopulationDraft({ name: input.name, entries: input.entries, ...(input.populationId === undefined ? {} : { populationId: input.populationId }), ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }))),
      publish: domainProcedure.input(z.object({ populationId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service().then((instance) => instance.publishPopulation(input))),
      deleteDraft: domainProcedure.input(deleteDraftInputSchema.extend({ populationId: identifierSchema }).strict()).mutation(({ input }) => service().then((instance) => instance.deletePopulationDraft(input))),
      deleteVersion: domainProcedure.input(deleteVersionInputSchema).mutation(({ input }) => service().then((instance) => instance.deletePopulationVersion(input))),
    }),
    agentBlueprints: t.router({
      list: domainProcedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.listAgentBlueprints(input.includeDeleted))),
      draft: domainProcedure.input(z.object({ blueprintId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getAgentBlueprintDraft(input.blueprintId, input.includeDeleted))),
      version: domainProcedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getAgentBlueprintVersion(input.versionRef, input.includeDeleted))),
      saveDraft: domainProcedure.input(z.object({ blueprintId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), definition: agentBlueprintDefinitionSchema }).strict()).mutation(({ input }) => service().then((instance) => instance.saveAgentBlueprintDraft({ name: input.name, definition: input.definition, ...(input.blueprintId === undefined ? {} : { blueprintId: input.blueprintId }), ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }))),
      publish: domainProcedure.input(z.object({ blueprintId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service().then((instance) => instance.publishAgentBlueprint(input))),
      deleteDraft: domainProcedure.input(deleteDraftInputSchema.extend({ blueprintId: identifierSchema }).strict()).mutation(({ input }) => service().then((instance) => instance.deleteAgentBlueprintDraft(input))),
      deleteVersion: domainProcedure.input(deleteVersionInputSchema).mutation(({ input }) => service().then((instance) => instance.deleteAgentBlueprintVersion(input))),
    }),
    turnPrompts: t.router({
      list: domainProcedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.listTurnPrompts(input.includeDeleted))),
      draft: domainProcedure.input(z.object({ promptId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getTurnPromptDraft(input.promptId, input.includeDeleted))),
      version: domainProcedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service().then((instance) => instance.getTurnPromptVersion(input.versionRef, input.includeDeleted))),
      saveDraft: domainProcedure.input(z.object({ promptId: identifierSchema.optional(), expectedRevision: z.number().int().positive().optional(), name: z.string().min(1).max(240), source: z.string().min(1).max(100_000), variables: z.array(turnPromptVariableDefinitionSchema).max(100) }).strict()).mutation(({ input }) => service().then((instance) => instance.saveTurnPromptDraft({ name: input.name, source: input.source, variables: input.variables, ...(input.promptId === undefined ? {} : { promptId: input.promptId }), ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }))),
      validate: domainProcedure.input(z.object({ source: z.string().min(1).max(100_000), variables: z.array(turnPromptVariableDefinitionSchema).max(100) }).strict()).mutation(({ input }) => service().then((instance) => instance.validateTurnPrompt(input))),
      preview: domainProcedure.input(z.object({ source: z.string().min(1).max(100_000), definitions: z.array(turnPromptVariableDefinitionSchema).max(100), variables: z.record(z.string(), turnPromptVariableValueSchema), utcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), roundId: z.number().int().nonnegative() }).strict()).mutation(({ input }) => service().then((instance) => instance.previewTurnPrompt(input))),
      publish: domainProcedure.input(z.object({ promptId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service().then((instance) => instance.publishTurnPrompt(input))),
      deleteDraft: domainProcedure.input(deleteDraftInputSchema.extend({ promptId: identifierSchema }).strict()).mutation(({ input }) => service().then((instance) => instance.deleteTurnPromptDraft(input))),
      deleteVersion: domainProcedure.input(deleteVersionInputSchema).mutation(({ input }) => service().then((instance) => instance.deleteTurnPromptVersion(input))),
    }),
    committedRounds: domainProcedure.input(z.object({ runId: identifierSchema }).merge(pageInputSchema)).output(committedPluginRoundListSchema).query(async ({ input }) =>
      committedPluginRoundListSchema.parse(await service().then((instance) => instance.committedRounds(input.runId, input)))),
    committedManifest: domainProcedure.input(z.object({ runId: identifierSchema, manifestRef: identifierSchema.optional() })).output(committedPluginManifestSchema).query(async ({ input }) =>
      committedPluginManifestSchema.parse(await service().then((instance) => instance.committedManifest(input.runId, input.manifestRef)))),
  }),
});
export type ExperimentRouter = typeof experimentRouter;
