import { Pool } from "pg";
import { bootstrapConfiguration } from "./bootstrap";
import { LlmConfigurationService } from "./service";
import { InMemoryConfigStore, PostgresConfigStore, SnapshotEncryption } from "./store";

declare global {
  // eslint-disable-next-line no-var
  var __openleekLlmConfigurationService: Promise<LlmConfigurationService> | undefined;
}

export function llmConfigurationService() {
  globalThis.__openleekLlmConfigurationService ??= createFromEnvironment();
  return globalThis.__openleekLlmConfigurationService;
}

async function createFromEnvironment() {
  const inMemory = process.env.OPENLEEK_LLM_CONFIGURATION_IN_MEMORY === "true";
  const store = inMemory ? new InMemoryConfigStore() : postgresStore();
  const service = new LlmConfigurationService(store);
  await service.initialize(() => bootstrapConfiguration(process.env));
  return service;
}

function postgresStore() {
  const databaseUrl = process.env.OPENLEEK_LLM_CONFIGURATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("OPENLEEK_LLM_CONFIGURATION_DATABASE_URL is required");
  const key = process.env.OPENLEEK_LLM_CONFIGURATION_ENCRYPTION_KEY;
  if (!key) throw new Error("OPENLEEK_LLM_CONFIGURATION_ENCRYPTION_KEY is required");
  return new PostgresConfigStore(new Pool({ connectionString: databaseUrl, max: 8 }), SnapshotEncryption.from(key));
}
