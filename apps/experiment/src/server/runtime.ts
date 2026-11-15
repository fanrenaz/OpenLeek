import { InMemoryExperimentRepository } from "./memory-repository";
import { createExperimentCredentialSigner } from "@openleek/experiment-credentials";
import { networkAgentExecution, networkContextGateway, networkPluginContexts } from "./network-ports";
import { networkContextAssetCommand, networkContextAssetRead } from "./network-ports";
import { contextCatalogSchema, type ContextCatalog } from "@openleek/contracts/context";
import { PostgresExperimentRepository } from "./postgres-repository";
import { ExperimentService } from "./service";

let service: ExperimentService | undefined;

function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function contextEndpoints(): Promise<Record<string, string>> {
  const registryUrl = url("OPENLEEK_CONTEXT_REGISTRY_URL");
  const token = url("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN");
  const response = await fetch(new URL("/internal/installations", registryUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Context Registry installations failed with HTTP ${response.status}`);
  const body = await response.json() as { installations?: Array<{ contextId: string; endpoint: string; state: string }> };
  return Object.fromEntries((body.installations ?? []).filter((item) => item.state === "active").map((item) => [item.contextId, item.endpoint]));
}

export async function contextCatalog(): Promise<ContextCatalog> {
  if (process.env.OPENLEEK_CONTEXT_REGISTRY_URL && process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN) {
    const response = await fetch(new URL("/internal/catalog", process.env.OPENLEEK_CONTEXT_REGISTRY_URL), { headers: { authorization: `Bearer ${process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Context Registry catalog failed with HTTP ${response.status}`);
    const body = await response.json() as { contexts?: unknown[] };
    return contextCatalogSchema.parse({ contexts: (body.contexts ?? []).map((descriptor) => ({ ...(descriptor as object), available: true })) });
  }
  throw new Error("Context Registry configuration is required");
}

export async function contextAssetRead(input: { contextId: string; collectionId: string; operation: "list" | "draft" | "version"; id?: string | undefined }): Promise<unknown> {
  const endpoint = (await contextEndpoints())[input.contextId];
  if (!endpoint) throw new Error(`Context '${input.contextId}' is not registered`);
  const { contextId: _contextId, ...request } = input;
  return networkContextAssetRead(endpoint, request);
}

export async function contextAssetCommand(input: { contextId: string; collectionId: string; operation: "save" | "validate" | "publish" | "preview" | "delete"; input?: unknown }): Promise<unknown> {
  const endpoint = (await contextEndpoints())[input.contextId];
  if (!endpoint) throw new Error(`Context '${input.contextId}' is not registered`);
  const { contextId: _contextId, ...request } = input;
  return networkContextAssetCommand(endpoint, request);
}

function credentialSignerFromEnvironment() {
  const kid = process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_KID;
  const privateKey = process.env.OPENLEEK_EXPERIMENT_CREDENTIAL_PRIVATE_KEY;
  if (!kid || !privateKey) {
    throw new Error("OPENLEEK_EXPERIMENT_CREDENTIAL_KID and OPENLEEK_EXPERIMENT_CREDENTIAL_PRIVATE_KEY are required");
  }
  return createExperimentCredentialSigner({ kid, privateKey: privateKey.replace(/\\n/g, "\n") });
}

/** Lazily initializes the Node-only service and its Context-owned schema. */
export async function experimentService(): Promise<ExperimentService> {
  if (service) return service;
  const ports = {
    agentExecution: networkAgentExecution(url("OPENLEEK_AGENT_EXECUTION_URL")),
    pluginContexts: networkPluginContexts(url("OPENLEEK_CONTEXT_REGISTRY_URL"), url("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN")),
    ...(process.env.OPENLEEK_CONTEXT_GATEWAY_URL && process.env.OPENLEEK_CONTEXT_GATEWAY_MANAGEMENT_TOKEN ? { contextGateway: networkContextGateway(process.env.OPENLEEK_CONTEXT_GATEWAY_URL, process.env.OPENLEEK_CONTEXT_GATEWAY_MANAGEMENT_TOKEN) } : {}),
  };
  if (process.env.OPENLEEK_EXPERIMENT_IN_MEMORY === "true") {
    service = new ExperimentService(new InMemoryExperimentRepository(), ports, { credentialSigner: credentialSignerFromEnvironment() });
    return service;
  }
  const repository = PostgresExperimentRepository.fromEnvironment();
  await repository.migrate();
  service = new ExperimentService(repository, ports, { credentialSigner: credentialSignerFromEnvironment() });
  return service;
}
