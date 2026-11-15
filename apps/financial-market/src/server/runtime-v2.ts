import { financialMcpPermissionsSchema } from "@openleek/contracts/agent";
import { contextRuntimeOperationSchema, contextRuntimeResultSchema, type DynamicContextRevision } from "@openleek/contracts/context";
import { financialMarketConfigurationSchema, financialMarketSectionSchema } from "@openleek/contracts/world";
import type { FinancialContextRevision } from "../application/revision-model";
import { sectionFromContract } from "../interfaces/trpc-router";
import { financialMarketRevisionService, financialMarketService } from "./runtime";

const external = (revision: FinancialContextRevision): DynamicContextRevision => ({ ref: revision.ref, context: "financial", runId: revision.runId, roundId: revision.roundId, digest: revision.digest, ...(revision.parentRevisionRef ? { parentRevisionRef: revision.parentRevisionRef } : {}), ...(revision.sourceManifestRef ? { sourceManifestRef: revision.sourceManifestRef } : {}) });
const internal = (revision: DynamicContextRevision): FinancialContextRevision => ({ ref: revision.ref, context: "financial_market", runId: revision.runId, roundId: revision.roundId, digest: revision.digest, ...(revision.parentRevisionRef ? { parentRevisionRef: revision.parentRevisionRef } : {}), ...(revision.sourceManifestRef ? { sourceManifestRef: revision.sourceManifestRef } : {}) });
const accountId = (agentId: string) => `account:${agentId}`;

export function authorizedContextRuntime(request: Request) {
  const expected = process.env.OPENLEEK_CONTEXT_BEARER_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

async function section(input: { runId: string; seed: number; configuration: Record<string, unknown>; participants: readonly { agentId: string; accountPolicy: Record<string, unknown> }[] }) {
  const configuration = financialMarketConfigurationSchema.parse(input.configuration);
  const market = await financialMarketService();
  const referencePrices = Object.fromEntries(configuration.instruments.map((instrument) => [instrument.symbol, instrument.referencePrice]));
  const accounts: Array<{ accountId: string; cash: number; positions: Record<string, number>; maximumActionsPerRound: number; initialStatePresetVersionRef?: string }> = [];
  for (const participant of input.participants) {
    const presetRef = participant.accountPolicy.initialStatePresetVersionRef;
    if (typeof presetRef !== "string") continue;
    const preset = await market.getFinancialInitialStatePresetVersion(presetRef);
    const resolved = await market.resolveFinancialInitialStatePreset({ versionRef: preset.versionRef, seed: String(input.seed), subjectId: participant.agentId, referencePrices, population: accounts.flatMap((account) => account.initialStatePresetVersionRef ? [{ initialStatePresetVersionRef: account.initialStatePresetVersionRef, cash: account.cash, positions: account.positions }] : []) });
    accounts.push({ accountId: accountId(participant.agentId), cash: resolved.cash, positions: resolved.positions, maximumActionsPerRound: Number(participant.accountPolicy.maximumActionsPerRound ?? 3), initialStatePresetVersionRef: preset.versionRef });
  }
  const value = { instruments: configuration.instruments, accounts } as { instruments: typeof configuration.instruments; accounts: typeof accounts; marketMaker?: unknown };
  if (configuration.marketMaker) {
    const selection = configuration.marketMaker;
    const preset = await market.getFinancialInitialStatePresetVersion(selection.initialStatePresetVersionRef);
    const resolved = await market.resolveFinancialInitialStatePreset({ versionRef: preset.versionRef, seed: String(input.seed), subjectId: `market-maker:${input.runId}`, referencePrices, population: accounts.flatMap((account) => account.initialStatePresetVersionRef ? [{ initialStatePresetVersionRef: account.initialStatePresetVersionRef, cash: account.cash, positions: account.positions }] : []) });
    const makerAccountId = `account:${input.runId}:market-maker`;
    accounts.push({ accountId: makerAccountId, cash: resolved.cash, positions: resolved.positions, maximumActionsPerRound: 0, initialStatePresetVersionRef: preset.versionRef });
    value.marketMaker = { versionRef: selection.versionRef, accountId: makerAccountId, timing: selection.timing, config: selection.config, ...(selection.matchingPolicy ? { matchingPolicy: selection.matchingPolicy } : {}), ...(selection.requotePolicy ? { requotePolicy: selection.requotePolicy } : {}), ...(selection.maxRequotesPerIntent ? { maxRequotesPerIntent: selection.maxRequotesPerIntent } : {}) };
  }
  return financialMarketSectionSchema.parse(value);
}

export async function executeFinancialRuntime(inputValue: unknown) {
  const input = contextRuntimeOperationSchema.parse(inputValue);
  const market = await financialMarketService();
  const revisions = await financialMarketRevisionService();
  if (input.operation === "validate") { financialMarketConfigurationSchema.parse(input.configuration); return contextRuntimeResultSchema.parse({ acknowledged: true }); }
  if (input.operation === "initialize") {
    const configured = await section({ runId: input.run.runId, seed: input.run.seed, configuration: input.configuration, participants: input.participants });
    const checkpoint = await market.initialize(input.run.runId, sectionFromContract(configured), input.mutation);
    return contextRuntimeResultSchema.parse({ revision: external(await revisions.initializeRevision({ runId: input.run.runId, checkpointRef: checkpoint.ref })) });
  }
  if (input.operation === "bind") {
    const bindings = await revisions.provisionMcpBindings({ runId: input.runId, roundId: input.revision.roundId, revision: internal(input.revision), agents: input.participants.map((participant) => ({ agentId: participant.agentId, principalId: participant.principalId, ...(typeof participant.accountPolicy.initialStatePresetVersionRef === "string" ? { accountId: accountId(participant.agentId) } : {}), permissions: financialMcpPermissionsSchema.parse({ tools: participant.tools, resources: participant.resources }) })) });
    const bearerByAgent = new Map(input.participants.map((participant) => [participant.agentId, participant.bearerToken]));
    return contextRuntimeResultSchema.parse({ bindings: bindings.map(({ agentId, endpoint }) => ({ contextId: "financial", agentId, endpoint, bearerToken: bearerByAgent.get(agentId)!, tools: input.participants.find((participant) => participant.agentId === agentId)!.tools, resources: input.participants.find((participant) => participant.agentId === agentId)!.resources })) });
  }
  if (input.operation === "freeze") return contextRuntimeResultSchema.parse({ revision: external(await revisions.freezeFullSnapshot({ runId: input.runId, roundId: input.roundId, baseline: internal(input.baseline) })) });
  if (input.operation === "open_scope") { const scope = await revisions.openMcpScope({ runId: input.runId, roundId: input.roundId, agentId: input.agentId, principalId: input.principalId, readRevision: internal(input.revision), turnId: input.turnId, attemptId: input.attemptId }); return contextRuntimeResultSchema.parse({ scope: { scopeId: scope.scopeId, runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, principalId: scope.principalId, turnId: scope.turnId, attemptId: scope.attemptId!, expiresAt: scope.expiresAt } }); }
  if (input.operation === "close_scope") { await revisions.closeMcpScope({ runId: input.runId, scopeId: input.scopeId }); return contextRuntimeResultSchema.parse({ acknowledged: true }); }
  if (input.operation === "settlement") { const value = await revisions.settlementStatus(input); return contextRuntimeResultSchema.parse({ settlement: { settled: value.settled, pendingCount: value.pendingIntentCount + value.pendingOutboxCount, rejectedCount: 0 } }); }
  if (input.operation === "seal") return contextRuntimeResultSchema.parse({ revision: external(await revisions.sealCandidateRevision({ runId: input.runId, roundId: input.roundId, finalFailedTurnIds: input.finalFailedTurnIds })) });
  if (input.operation === "publish") return contextRuntimeResultSchema.parse({ revision: external(await revisions.commitRevision(input.runId, input.candidate.ref)) });
  if (input.operation === "fork") return contextRuntimeResultSchema.parse({ revision: external(await revisions.forkRevision({ sourceRunId: input.sourceRunId, sourceRevisionRef: input.sourceRevision.ref, targetRunId: input.targetRun.runId })) });
  await revisions.revokeMcpAccess(input.runId);
  return contextRuntimeResultSchema.parse({ acknowledged: true });
}
