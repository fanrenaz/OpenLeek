import { sha256 } from "./canonical";
import { OPENLEEK_CONTEXT_COMPACTION_POLICY } from "./runtime-instructions";
import type { CodexRuntimeProfile } from "./types";
import { renderCodexConfig } from "./workspace-artifacts";

export const DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_PROVIDER = "deepseek";

const providerConfigToml = [
  `model = "${DEEPSEEK_MODEL}"`,
  `model_provider = "${DEEPSEEK_PROVIDER}"`,
  'model_reasoning_effort = "high"',
  "",
  `[model_providers.${DEEPSEEK_PROVIDER}]`,
  'name = "DeepSeek"',
  'base_url = "https://api.deepseek.com/"',
  'wire_api = "responses"',
  'env_key = "DEEPSEEK_API_KEY"',
  "",
].join("\n");

const models = {
  models: [
    {
      slug: DEEPSEEK_MODEL,
      display_name: "DeepSeek V4 Flash",
      description: "DeepSeek V4 Flash with high reasoning effort and tool calling.",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "high", description: "High reasoning effort" },
        { effort: "xhigh", description: "Maximum DeepSeek reasoning effort" },
      ],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      additional_speed_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "You are DeepSeek V4 Flash, a coding agent.",
      supports_reasoning_summaries: true,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: false,
      context_window: 1000000,
      max_context_window: 1000000,
      max_output_tokens: 384000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: false,
    },
  ],
};

const modelsJson = `${JSON.stringify(models, null, 2)}\n`;

export function deepSeekCodexProfile(reasoningEffort: "high" | "xhigh" = "high"): CodexRuntimeProfile {
  const selectedProviderConfigToml = providerConfigToml.replace('model_reasoning_effort = "high"', `model_reasoning_effort = "${reasoningEffort}"`);
  const configToml = renderCodexConfig(selectedProviderConfigToml, [], OPENLEEK_CONTEXT_COMPACTION_POLICY, true);
  return {
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    reasoningEffort,
    providerConfigToml: selectedProviderConfigToml,
    modelsJson,
    configDigest: sha256({ configToml, modelsJson }),
  };
}
