import { normalizeConfig, parseFullConfig, type FullConfig } from "./model";

export async function bootstrapConfiguration(environment: NodeJS.ProcessEnv): Promise<FullConfig> {
  const inline = environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_JSON;
  if (inline) return parseFullConfig(JSON.parse(inline));
  if (environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_API_KEY) return fromEnvironmentConfig(environment);
  if (environment.OPENLEEK_LLM_CONFIGURATION_IN_MEMORY === "true") return testConfiguration();
  throw new Error("LLM Configuration bootstrap environment is required for an empty store");
}

export function fromEnvironmentConfig(environment: Readonly<Record<string, string | undefined>>): FullConfig {
  const provider = environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_PROVIDER ?? "memory";
  const model = string(environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_MODEL, "OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_MODEL");
  const baseUrl = string(environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_BASE_URL, "OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_BASE_URL");
  const apiKey = string(environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_API_KEY, "OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_API_KEY");
  const protocol = environment.OPENLEEK_LLM_CONFIGURATION_BOOTSTRAP_PROTOCOL ?? "openai-chat";
  return normalizeConfig({
    resources: [
      { kind: "defaults", id: "main", value: { model: "memory", memory_route: "memory", max_tokens: 8192 } },
      { kind: "provider", id: provider, value: { protocol, base_url: baseUrl, api_key: apiKey } },
      { kind: "model", id: model, value: { context_window: 128_000, max_output_tokens: 8192, supports_parallel_tool_calls: false } },
      { kind: "provider_offer", id: `${provider}/${model}`, value: { provider, model } },
      { kind: "route", id: "memory", value: { provider, model } },
    ],
  });
}

export function testConfiguration(): FullConfig {
  return normalizeConfig({
    resources: [
      { kind: "defaults", id: "main", value: { model: "agent", memory_route: "memory", max_tokens: 8192 } },
      { kind: "provider", id: "test", value: { protocol: "anthropic", base_url: "https://example.invalid/anthropic", api_key: "test-secret", version: "2023-06-01" } },
      { kind: "model", id: "agent-model", value: { context_window: 128_000, max_output_tokens: 8192, supports_parallel_tool_calls: true } },
      { kind: "model", id: "memory-model", value: { context_window: 128_000, max_output_tokens: 4096, supports_parallel_tool_calls: false } },
      { kind: "provider_offer", id: "test/agent-model", value: { provider: "test", model: "agent-model" } },
      { kind: "provider_offer", id: "test/memory-model", value: { provider: "test", model: "memory-model" } },
      { kind: "route", id: "agent", value: { provider: "test", model: "agent-model" } },
      { kind: "route", id: "memory", value: { provider: "test", model: "memory-model" } },
    ],
  });
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}
