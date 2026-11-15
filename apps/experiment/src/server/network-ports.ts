import { anyContextDescriptorSchema, checkpointSchema, contextPluginDescriptorSchema, contextRuntimeOperationSchema, contextRuntimeResultSchema, dynamicContextRevisionSchema, type AnyContextDescriptor, type Checkpoint } from "@openleek/contracts/context";
import { createContextClient } from "@openleek/trpc";
import type { AnyRouter } from "@trpc/server";
import type { AgentExecutionPort, ContextGatewayPort, PluginContextPort } from "./model";

type RpcProcedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type ContextRpcClient = {
  contextPlugin: Record<"descriptor" | "assetRead" | "assetCommand", RpcProcedure>;
  agentExecution: Record<"validate" | "initialize" | "execute" | "seal" | "publish" | "fork" | "release", RpcProcedure> & { agentsMd: Record<"version", RpcProcedure>; mcpPolicies: Record<"version", RpcProcedure>; skills: Record<"version", RpcProcedure> };
};

const rpc = (url: string) => createContextClient<AnyRouter>(url) as unknown as ContextRpcClient;
const checkpoint = (value: unknown): Checkpoint => checkpointSchema.parse(thisOrProperty(value, "checkpoint"));
/** Context owners may return owner-specific revision metadata. Keep that data at
 * the owner boundary while projecting only the canonical fields Experiment is
 * allowed to persist in its manifest. */
export const dynamicRevision = (value: unknown) => {
  const candidate = thisOrProperty(value, "revision");
  if (!candidate || typeof candidate !== "object") return dynamicContextRevisionSchema.parse(candidate);
  const record = candidate as Record<string, unknown>;
  return dynamicContextRevisionSchema.parse({
    ref: record.ref,
    context: record.context,
    runId: record.runId,
    roundId: record.roundId,
    digest: record.digest,
    ...(record.parentRevisionRef === undefined ? {} : { parentRevisionRef: record.parentRevisionRef }),
    ...(record.sourceManifestRef === undefined ? {} : { sourceManifestRef: record.sourceManifestRef }),
  });
};
function thisOrProperty(value: unknown, property: string): unknown {
  return value && typeof value === "object" && property in value ? (value as Record<string, unknown>)[property] : value;
}

export async function networkContextDescriptor(url: string): Promise<AnyContextDescriptor> {
  return anyContextDescriptorSchema.parse(await rpc(url).contextPlugin.descriptor.query({}));
}

export async function networkContextAssetRead(url: string, input: unknown): Promise<unknown> {
  return rpc(url).contextPlugin.assetRead.query(input);
}

export async function networkContextAssetCommand(url: string, input: unknown): Promise<unknown> {
  return rpc(url).contextPlugin.assetCommand.mutate(input);
}

export function networkAgentExecution(url: string): AgentExecutionPort {
  const client = rpc(url);
  return {
    async validate(section) { return await client.agentExecution.validate.query(section) as Awaited<ReturnType<AgentExecutionPort["validate"]>>; },
    async validateAgentsMdVersions(versionRefs) {
      await Promise.all(uniqueVersionRefs(versionRefs).map((versionRef) => client.agentExecution.agentsMd.version.query({ versionRef })));
    },
    async mcpPolicyVersion(versionRef) { return await client.agentExecution.mcpPolicies.version.query({ versionRef }) as Awaited<ReturnType<AgentExecutionPort["mcpPolicyVersion"]>>; },
    async skillVersion(versionRef) { return await client.agentExecution.skills.version.query({ versionRef }) as Awaited<ReturnType<AgentExecutionPort["skillVersion"]>>; },
    async initialize(runId, input, mutation, mcp) { return checkpoint(await client.agentExecution.initialize.mutate({ runId, ...input, mutation, mcp })); },
    async execute(input) { await client.agentExecution.execute.mutate(input); },
    async seal(input) { return checkpoint(await client.agentExecution.seal.mutate(input)); },
    async publish(input) { await client.agentExecution.publish.mutate(input); },
    async fork(input) { return checkpoint(await client.agentExecution.fork.mutate({ ...input, sourceCheckpoint: input.source })); },
    async release(runId) { await client.agentExecution.release.mutate({ runId }); },
  };
}

export function uniqueVersionRefs(versionRefs: readonly string[]): string[] {
  return [...new Set(versionRefs)];
}

export function networkContextGateway(url: string, managementToken: string): ContextGatewayPort {
  return {
    async issue(input) {
      const response = await fetch(new URL("/internal/bindings", url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${managementToken}` },
        body: JSON.stringify({ runId: input.runId, agentId: input.agentId, expiresAt: "9999-12-31T23:59:59.999Z", routes: [{ contextId: input.contextId, ...(input.installationRef ? { installationRef: input.installationRef } : { endpoint: input.endpoint }), upstreamCredential: input.upstreamCredential, tools: input.tools, resources: input.resources }] }),
      });
      if (!response.ok) throw new Error(`Context Gateway binding failed with HTTP ${response.status}`);
      return await response.json() as { endpoint: string; bearerToken: string };
    },
    async revokeRun(runId) {
      const endpoint = new URL("/internal/bindings", url); endpoint.searchParams.set("runId", runId);
      const response = await fetch(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${managementToken}` } });
      if (!response.ok) throw new Error(`Context Gateway revocation failed with HTTP ${response.status}`);
    },
  };
}

export function networkPluginContexts(registryUrl: string, managementToken: string): PluginContextPort {
  const headers = { authorization: `Bearer ${managementToken}` };
  return {
    async catalog() {
      const response = await fetch(new URL("/internal/catalog", registryUrl), { headers, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Context Registry catalog failed with HTTP ${response.status}`);
      const body = await response.json() as { contexts?: unknown[] };
      return (body.contexts ?? []).map((value) => contextPluginDescriptorSchema.parse(value));
    },
    async execute(installationRef, input) {
      const resolution = await fetch(new URL(`/internal/installations/${encodeURIComponent(installationRef)}`, registryUrl), { headers, signal: AbortSignal.timeout(5_000) });
      if (!resolution.ok) throw new Error(`Context installation resolution failed with HTTP ${resolution.status}: ${await resolution.text()}`);
      const resolved = await resolution.json() as { installation: { endpoint: string }; bearerToken: string };
      const response = await fetch(new URL("/api/context/v2/runtime", resolved.installation.endpoint), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${resolved.bearerToken}` }, body: JSON.stringify(contextRuntimeOperationSchema.parse(input)), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Context runtime failed with HTTP ${response.status}: ${await response.text()}`);
      return contextRuntimeResultSchema.parse(await response.json());
    },
  };
}
