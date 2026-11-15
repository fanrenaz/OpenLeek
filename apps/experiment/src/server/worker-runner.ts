import { networkAgentExecution, networkContextGateway, networkPluginContexts } from "./network-ports";
import { createExperimentCredentialSigner } from "@openleek/experiment-credentials";
import { emitObservabilityLog, SeverityNumber } from "@openleek/observability";
import { PostgresExperimentRepository } from "./postgres-repository";
import { ExperimentService, RoundWorker } from "./service";

declare global { var __openleekExperimentWorker: Promise<void> | undefined; }

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function credentialSignerFromEnvironment() {
  return createExperimentCredentialSigner({
    kid: required("OPENLEEK_EXPERIMENT_CREDENTIAL_KID"),
    privateKey: required("OPENLEEK_EXPERIMENT_CREDENTIAL_PRIVATE_KEY").replace(/\\n/g, "\n"),
  });
}

/** Starts exactly one consumer inside the dedicated worker service process. */
export function startExperimentWorker(): void {
  if (globalThis.__openleekExperimentWorker) return;
  globalThis.__openleekExperimentWorker = (async () => {
    const repository = PostgresExperimentRepository.fromEnvironment();
    await repository.migrate();
    const service = new ExperimentService(repository, {
      agentExecution: networkAgentExecution(required("OPENLEEK_AGENT_EXECUTION_URL")),
      pluginContexts: networkPluginContexts(required("OPENLEEK_CONTEXT_REGISTRY_URL"), required("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN")),
      ...(process.env.OPENLEEK_CONTEXT_GATEWAY_URL && process.env.OPENLEEK_CONTEXT_GATEWAY_MANAGEMENT_TOKEN ? { contextGateway: networkContextGateway(process.env.OPENLEEK_CONTEXT_GATEWAY_URL, process.env.OPENLEEK_CONTEXT_GATEWAY_MANAGEMENT_TOKEN) } : {}),
    }, { credentialSigner: credentialSignerFromEnvironment() });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await new RoundWorker(repository, service, { workerId: process.env.OPENLEEK_WORKER_ID ?? `worker:${process.pid}` }).runForever(controller.signal);
    } finally {
      await repository.close();
    }
  })().catch((error) => {
    emitObservabilityLog("worker.terminated", {
      "openleek.worker": "experiment",
      code: error instanceof Error ? error.name : "unknown",
      outcome: "error",
    }, SeverityNumber.FATAL);
    console.error("experiment worker terminated");
    process.exitCode = 1;
    throw error;
  });
}
