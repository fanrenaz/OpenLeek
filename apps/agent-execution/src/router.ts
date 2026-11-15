import { agentExecutionSectionSchema, mcpPolicyDefinitionSchema, skillDefinitionSchema } from "@openleek/contracts/agent";
import { deleteDraftInputSchema, deleteVersionInputSchema } from "@openleek/contracts/assets";
import { checkpointSchema, committedFactQuerySchema } from "@openleek/contracts/context";
import { dataDictionarySourceSchema } from "@openleek/contracts/data-dictionary";
import { identifierSchema, mutationHeaderSchema } from "@openleek/contracts/core";
import {
  agentRuntimeEvidenceSchema,
  agentSessionTranscriptPageSchema,
  committedExecutionPageSchema,
  runTokenUsageSchema,
} from "@openleek/contracts/observability";
import { frozenTurnPromptSchema } from "@openleek/contracts/turn-prompt";
import { OpenLeekDomainError, domainProcedure, t } from "@openleek/trpc";
import { z } from "zod";

import { AgentExecutionError, invalidArgument, preconditionFailed } from "./errors";
import { AgentExecutionService } from "./service";
import { agentExecutionDataDictionary } from "./data-dictionary";

const executeInputSchema = z.object({
  runId: identifierSchema,
  roundId: z.number().int().nonnegative(),
  agentId: identifierSchema,
  attemptId: identifierSchema,
  orchestrationTurnId: identifierSchema,
  mutation: mutationHeaderSchema,
  baseline: checkpointSchema,
  utcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const mcpConnectionSchema = z.object({
  context: identifierSchema,
  agentId: identifierSchema,
  principalId: identifierSchema,
  endpoint: z.string().url(),
  credential: z.string().min(32),
});
const resolvedAgentSchema = z.object({
  agentId: identifierSchema,
  agentsMdVersionRef: identifierSchema,
  skillVersionRefs: z.array(identifierSchema).max(100).default([]),
  mcpContexts: z.array(identifierSchema).max(100).default([]),
}).strict();
const agentsMdDraftSchema = z.object({
  templateId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
  source: z.string().min(1).max(250_000),
}).strict();
const mcpPolicyDraftSchema = mcpPolicyDefinitionSchema.extend({
  policyId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
}).strict();
const skillDraftSchema = skillDefinitionSchema.extend({
  skillId: identifierSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(240),
}).strict();
/**
 * The only browser/network-facing API for this bounded Context. Other
 * contexts consume it through a tRPC network client, never by importing it.
 */
export function createAgentExecutionRouter(service: AgentExecutionService) {
  const procedure = domainProcedure.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof AgentExecutionError) {
        throw new OpenLeekDomainError({
          code: error.code,
          message: error.message,
          violations: [...error.violations],
        });
      }
      throw error;
    }
  });
  const committedFactProcedure = procedure
    .input(committedFactQuerySchema)
    .output(committedExecutionPageSchema)
    .query(async ({ input }) => {
      const offset = decodeCursor(input.cursor);
      const facts = await service.listCommittedFacts(input.runId);
      const items = facts.slice(offset, offset + input.limit);
      const nextOffset = offset + items.length;
      return committedExecutionPageSchema.parse({
        items,
        ...(nextOffset < facts.length ? { nextCursor: `offset:${nextOffset}` } : {}),
      });
    });
  return t.router({
    agentExecution: t.router({
      dataDictionary: t.router({
        catalog: procedure
          .input(z.object({}).strict())
          .output(dataDictionarySourceSchema)
          .query(() => agentExecutionDataDictionary),
      }),
      validate: procedure
        .input(agentExecutionSectionSchema)
        .query(({ input }) => service.validate(input)),

      /** Non-secret runtime capability used by Console when creating a run. */
      runtimeCapability: procedure
        .input(z.object({}))
        .query(() => service.runtimeCapability()),
      executionProviders: procedure.input(z.object({}).strict()).query(() => service.executionProviders()),
      chatGptAuth: t.router({
        status: procedure.input(z.object({}).strict()).query(() => service.chatGptAuthStatus()),
        rateLimits: procedure.input(z.object({}).strict()).query(() => service.chatGptRateLimits()),
        startDeviceAuthorization: procedure.input(z.object({}).strict()).mutation(() => service.startChatGptDeviceAuthorization()),
        cancelDeviceAuthorization: procedure.input(z.object({}).strict()).mutation(() => service.cancelChatGptDeviceAuthorization()),
        logout: procedure.input(z.object({}).strict()).mutation(() => service.logoutChatGpt()),
      }),

      initialize: procedure
        .input(z.object({
          runId: identifierSchema,
          section: agentExecutionSectionSchema,
          turnPrompt: frozenTurnPromptSchema,
          agents: z.array(resolvedAgentSchema).min(1),
          mutation: mutationHeaderSchema,
          mcp: z.array(mcpConnectionSchema),
        }))
        .mutation(async ({ input }) => {
          const agents = input.agents;
          const outcome = await service.initialize(input.runId, { section: input.section, turnPrompt: input.turnPrompt, agents }, input.mutation, input.mcp);
          return { checkpoint: outcome.value };
        }),

      execute: procedure
        .input(executeInputSchema)
        .mutation(async ({ input }) => {
          if (input.mutation.expectedCheckpointRef !== input.baseline.ref) {
            preconditionFailed("execute baseline must match mutation.expectedCheckpointRef");
          }
          await service.execute({
            runId: input.runId,
            roundId: input.roundId,
            mutation: input.mutation,
            agentId: input.agentId,
            attemptId: input.attemptId,
            orchestrationTurnId: input.orchestrationTurnId,
            utcDate: input.utcDate,
          });
          return {};
        }),

      seal: procedure
        .input(z.object({
          runId: identifierSchema,
          roundId: z.number().int().nonnegative(),
          mutation: mutationHeaderSchema,
        }))
        .mutation(async ({ input }) => {
          const outcome = await service.seal(input.runId, input.roundId, input.mutation);
          return { checkpoint: outcome.value };
        }),

      publish: procedure
        .input(z.object({
          runId: identifierSchema,
          roundId: z.number().int().nonnegative(),
          mutation: mutationHeaderSchema,
          checkpoint: checkpointSchema,
        }))
        .mutation(async ({ input }) => {
          await service.publish(input.runId, input.roundId, input.checkpoint.ref, input.mutation);
          return { checkpoint: input.checkpoint };
        }),

      fork: procedure
        .input(z.object({
          sourceRunId: identifierSchema,
          targetRunId: identifierSchema,
          sourceCheckpoint: checkpointSchema,
          mutation: mutationHeaderSchema,
          mcp: z.array(mcpConnectionSchema),
          agentsMdByAgentId: z.record(identifierSchema, identifierSchema).default({}),
          turnPrompt: frozenTurnPromptSchema.optional(),
          section: agentExecutionSectionSchema.optional(),
        }))
        .mutation(async ({ input }) => {
          const outcome = await service.fork(
            input.sourceRunId,
            input.targetRunId,
            input.sourceCheckpoint.ref,
            input.mutation,
            input.mcp,
            input.agentsMdByAgentId,
            input.turnPrompt,
            input.section,
          );
          return { checkpoint: outcome.value };
        }),

      /** Internal orchestration release; safe to repeat after a completed run. */
      release: procedure
        .input(z.object({ runId: identifierSchema }))
        .mutation(({ input }) => service.release(input.runId)),

      committedFacts: committedFactProcedure,
      /** Compatibility name used by Console's cross-Context fact port. */
      queryCommittedFacts: committedFactProcedure,
      runtimeEvidence: procedure
        .input(z.object({ runId: identifierSchema }))
        .output(agentRuntimeEvidenceSchema)
        .query(async ({ input }) => agentRuntimeEvidenceSchema.parse(await service.runtimeEvidence(input.runId))),
      tokenUsage: procedure
        .input(z.object({ runId: identifierSchema }))
        .output(runTokenUsageSchema)
        .query(async ({ input }) => runTokenUsageSchema.parse(await service.tokenUsage(input.runId))),
      transcripts: procedure
        .input(z.object({
          runId: identifierSchema,
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
          agentId: identifierSchema.optional(),
          roundId: z.number().int().nonnegative().optional(),
          attemptId: identifierSchema.optional(),
          turnId: identifierSchema.optional(),
        }).strict())
        .output(agentSessionTranscriptPageSchema)
        .query(async ({ input }) => agentSessionTranscriptPageSchema.parse(await service.transcripts(input.runId, {
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.roundId === undefined ? {} : { roundId: input.roundId }),
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        }))),
      hookPolicy: t.router({
        get: procedure
          .input(z.object({ runId: identifierSchema }).strict())
          .query(({ input }) => service.getHookPolicy(input.runId)),
        update: procedure
          .input(z.object({
            runId: identifierSchema,
            strategyInjectionEnabled: z.boolean(),
            expectedRevision: z.number().int().positive(),
            idempotencyKey: identifierSchema,
          }).strict())
          .mutation(({ input }) => service.updateHookPolicy(input)),
      }),
      agentsMd: t.router({
        list: procedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.listAgentsMd(input.includeDeleted)),
        draft: procedure.input(z.object({ templateId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getAgentsMdDraft(input.templateId, input.includeDeleted)),
        version: procedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getAgentsMdVersion(input.versionRef, input.includeDeleted)),
        saveDraft: procedure.input(agentsMdDraftSchema).mutation(({ input }) => service.saveAgentsMdDraft({
          name: input.name,
          source: input.source,
          ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        })),
        publish: procedure.input(z.object({ templateId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service.publishAgentsMd(input)),
        deleteDraft: procedure.input(deleteDraftInputSchema.extend({ templateId: identifierSchema }).strict()).mutation(({ input }) => service.deleteAgentsMdDraft(input)),
        deleteVersion: procedure.input(deleteVersionInputSchema).mutation(({ input }) => service.deleteAgentsMdVersion(input)),
      }),
      mcpPolicies: t.router({
        list: procedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.listMcpPolicies(input.includeDeleted)),
        draft: procedure.input(z.object({ policyId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getMcpPolicyDraft(input.policyId, input.includeDeleted)),
        version: procedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getMcpPolicyVersion(input.versionRef, input.includeDeleted)),
        saveDraft: procedure.input(mcpPolicyDraftSchema).mutation(({ input }) => service.saveMcpPolicyDraft({
          name: input.name,
          tools: input.tools,
          resources: input.resources,
          contexts: input.contexts,
          ...(input.policyId === undefined ? {} : { policyId: input.policyId }),
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        })),
        publish: procedure.input(z.object({ policyId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service.publishMcpPolicy(input)),
        deleteDraft: procedure.input(deleteDraftInputSchema.extend({ policyId: identifierSchema }).strict()).mutation(({ input }) => service.deleteMcpPolicyDraft(input)),
        deleteVersion: procedure.input(deleteVersionInputSchema).mutation(({ input }) => service.deleteMcpPolicyVersion(input)),
      }),
      skills: t.router({
        list: procedure.input(z.object({ includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.listSkills(input.includeDeleted)),
        draft: procedure.input(z.object({ skillId: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getSkillDraft(input.skillId, input.includeDeleted)),
        version: procedure.input(z.object({ versionRef: identifierSchema, includeDeleted: z.boolean().optional() }).strict()).query(({ input }) => service.getSkillVersion(input.versionRef, input.includeDeleted)),
        validate: procedure.input(skillDefinitionSchema).mutation(({ input }) => service.validateSkill(input)),
        saveDraft: procedure.input(skillDraftSchema).mutation(({ input }) => service.saveSkillDraft({
          name: input.name,
          files: input.files,
          requirements: input.requirements,
          ...(input.skillId === undefined ? {} : { skillId: input.skillId }),
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        })),
        publish: procedure.input(z.object({ skillId: identifierSchema, expectedRevision: z.number().int().positive() }).strict()).mutation(({ input }) => service.publishSkill(input)),
        deleteDraft: procedure.input(deleteDraftInputSchema.extend({ skillId: identifierSchema }).strict()).mutation(({ input }) => service.deleteSkillDraft(input)),
        deleteVersion: procedure.input(deleteVersionInputSchema).mutation(({ input }) => service.deleteSkillVersion(input)),
        validateVersions: procedure.input(z.object({ versionRefs: z.array(identifierSchema).max(100) }).strict()).query(({ input }) => service.validateSkillVersions(input.versionRefs)),
      }),
    }),
  });
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (match?.[1] === undefined) invalidArgument("invalid committed facts cursor", { cursor: "must be an Agent Execution cursor" });
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) invalidArgument("invalid committed facts cursor", { cursor: "offset is invalid" });
  return offset;
}
