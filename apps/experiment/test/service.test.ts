import assert from "node:assert/strict";
import test from "node:test";

import { sha256Digest } from "@openleek/contracts/canonical";
import type { ContextPluginDescriptor, ContextRuntimeOperation, ContextRuntimeResult, DynamicContextRevision } from "@openleek/contracts/context";
import type { PluginSpecification } from "@openleek/contracts/experiment";
import { createExperimentCredentialSigner, generateExperimentCredentialKeyPair } from "@openleek/experiment-credentials";
import { InMemoryExperimentRepository } from "../src/server/memory-repository.js";
import type { ContextPorts } from "../src/server/model.js";
import { ExperimentService, RoundWorker } from "../src/server/service.js";

const keys = generateExperimentCredentialKeyPair();
const signer = createExperimentCredentialSigner({ kid: "test", privateKey: keys.privateKeyPem });
const contexts = ["social", "financial", "news"] as const;

function descriptor(contextId: string): ContextPluginDescriptor {
  return {
    schemaVersion: "3", contextId, revision: `${contextId}-context:v3`, runtimeProtocol: "openleek-context-runtime/v2",
    label: { default: contextId, translations: {} }, description: { default: `${contextId} fixture`, translations: {} },
    agentEnvironment: { accountPolicySchema: {}, accountPolicyUiSchema: {}, capabilities: [{ id: `${contextId}.read`, kind: "tool", label: { default: "Read", translations: {} } }] },
    worldEnvironment: { collections: [] }, experimentConfigurationSchema: {}, experimentConfigurationUiSchema: {},
    infrastructure: { postgres: false, redis: false }, agentAccess: "read-write", observerViews: [],
  };
}

function revision(contextId: string, runId: string, roundId: number, suffix: string): DynamicContextRevision {
  return { ref: `revision:${contextId}:${runId}:${roundId}:${suffix}`, context: contextId, runId, roundId, digest: sha256Digest({ contextId, runId, roundId, suffix }) };
}

function fixturePorts(operations: ContextRuntimeOperation[]): ContextPorts {
  return {
    pluginContexts: {
      async catalog() { return contexts.map(descriptor); },
      async execute(installationRef, operation): Promise<ContextRuntimeResult> {
        operations.push(operation);
        const contextId = installationRef.replace("installation:", "");
        if (operation.operation === "initialize") return { revision: revision(contextId, operation.run.runId, 0, "initial") };
        if (operation.operation === "bind") return { bindings: operation.participants.map((participant) => ({ contextId, agentId: participant.agentId, endpoint: `http://${contextId}.test/mcp`, bearerToken: participant.bearerToken, tools: participant.tools, resources: participant.resources })) };
        if (operation.operation === "freeze") return { revision: revision(contextId, operation.runId, operation.roundId, "read") };
        if (operation.operation === "open_scope") return { scope: { scopeId: `scope:${contextId}:${operation.turnId}`, runId: operation.runId, roundId: operation.roundId, agentId: operation.agentId, principalId: operation.principalId, turnId: operation.turnId, attemptId: operation.attemptId, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        if (operation.operation === "settlement") return { settlement: { settled: true, pendingCount: 0, rejectedCount: 0 } };
        if (operation.operation === "seal") return { revision: revision(contextId, operation.runId, operation.roundId, "sealed") };
        if (operation.operation === "publish" || operation.operation === "fork") return { revision: operation.operation === "publish" ? operation.candidate : revision(contextId, operation.targetRun.runId, operation.sourceRevision.roundId, "fork") };
        return { acknowledged: true };
      },
    },
    agentExecution: {
      async validate(value) { return value; }, async validateAgentsMdVersions() {},
      async mcpPolicyVersion(versionRef) { return { versionRef, artifactDigest: "b".repeat(64), tools: contexts.map((id) => `${id}.read`), resources: [], contexts: Object.fromEntries(contexts.map((id) => [id, { enabled: true, accountPolicy: {} }])) }; },
      async skillVersion(versionRef) { return { versionRef, artifactDigest: "c".repeat(64), skillName: "fixture" }; },
      async initialize(runId, input) { return { ref: `agent:${runId}:0`, runId, roundId: 0, digest: sha256Digest(input) }; },
      async execute() {}, async seal(input) { return { ref: `agent:${input.runId}:${input.roundId}`, runId: input.runId, roundId: input.roundId, digest: sha256Digest(input) }; }, async publish() {},
      async fork(input) { return { ...input.source, ref: `agent:${input.targetRunId}:${input.source.roundId}`, runId: input.targetRunId }; }, async release() {},
    },
  };
}

async function seed(repository: InMemoryExperimentRepository) {
  await repository.saveTurnPromptVersion({ promptId: "test", name: "Test", source: "Round {{roundId}}", variables: [], versionRef: "turn-prompt:test:v1", artifactDigest: "1".repeat(64), publishedAt: "2026-01-01T00:00:00.000Z", draftRevision: 1 });
  await repository.saveAgentBlueprintVersion({ blueprintId: "fixture", name: "Fixture", agentsMdVersionRef: "agents-md:fixture:v1", mcpPolicyVersionRef: "mcp-policy:fixture:v1", skillVersionRefs: [], versionRef: "agent-blueprint:fixture:v1", artifactDigest: "2".repeat(64), publishedAt: "2026-01-01T00:00:00.000Z", draftRevision: 1 });
  await repository.savePopulationVersion({ populationId: "fixture", name: "Fixture", entries: [{ key: "fixture", count: 1, agentBlueprintVersionRef: "agent-blueprint:fixture:v1" }], versionRef: "population:fixture:v1", artifactDigest: "3".repeat(64), publishedAt: "2026-01-01T00:00:00.000Z", draftRevision: 1 });
}

function specification(): PluginSpecification {
  return {
    schemaVersion: "3", seed: 7, roundCount: 1, clock: { startUnixSeconds: 0, stepSeconds: 60 }, executionPolicy: { automaticRetryMaxAttempts: 1, automaticRetryBackoffMs: 0 },
    initialWorld: { worldName: "fixture", scenarioVersion: "1", population: { versionRef: "population:fixture:v1" }, nameTheme: "research-codes-v1" },
    turnPrompt: { versionRef: "turn-prompt:test:v1", variables: {} }, agentExecution: { maxConcurrentAgents: 1, toolCallBudget: { maxCallsPerToolPerTurn: 2 } },
    researchTemplate: { versionRef: "research-template:tri-context:v1" },
    contexts: Object.fromEntries(contexts.map((id) => [id, { installationRef: `installation:${id}`, descriptorRevision: `${id}-context:v3`, configuration: {} }])),
  };
}

test("v3 drives every selected Context through the same Runtime v2 lifecycle", async () => {
  const repository = new InMemoryExperimentRepository();
  await seed(repository);
  const operations: ContextRuntimeOperation[] = [];
  const service = new ExperimentService(repository, fixturePorts(operations), { credentialSigner: signer, settlementTimeoutMs: 1_000 });
  const value = specification();
  const digest = sha256Digest(value);
  const status = await service.createRun({ mutation: { transitionId: "generic-v3", stepId: "create", expectedCheckpointRef: "", payloadDigest: digest }, specification: value });
  await service.resumeRun({ runId: status.runId, mutation: { transitionId: "resume", stepId: "resume", expectedCheckpointRef: "", payloadDigest: sha256Digest({}) } });
  const worker = new RoundWorker(repository, service, { workerId: "test" });
  for (let turn = 0; turn < 20 && (await service.getRun(status.runId)).status.lifecycle !== "completed"; turn += 1) await worker.runOnce();
  const completed = await service.getRun(status.runId);
  assert.equal(completed.status.lifecycle, "completed");
  assert.equal((await service.committedManifest(status.runId)).schemaVersion, "3");
  for (const contextId of contexts) for (const operation of ["validate", "initialize", "bind", "freeze", "open_scope", "close_scope", "settlement", "seal", "publish"]) assert.ok(operations.some((item) => item.operation === operation && ("revision" in item ? item.revision.context === contextId : "baseline" in item ? item.baseline.context === contextId : true)), `${contextId} missing ${operation}`);
});

test("Runtime v2 dispatch accepts a fourth Context without a core adapter", async () => {
  const operations: ContextRuntimeOperation[] = [];
  const port = fixturePorts(operations).pluginContexts;
  const result = await port.execute("installation:weather", { operation: "validate", configuration: { climate: "dry" }, participants: [] });
  assert.equal(result.acknowledged, true);
  assert.deepEqual(operations, [{ operation: "validate", configuration: { climate: "dry" }, participants: [] }]);
});
