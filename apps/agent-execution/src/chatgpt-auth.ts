import { sha256 } from "./canonical";
import { OPENLEEK_CONTEXT_COMPACTION_POLICY } from "./runtime-instructions";
import type { CodexRuntimeProfile } from "./types";
import { renderCodexConfig } from "./workspace-artifacts";

export interface ChatGptModel {
  readonly id: string;
  readonly displayName: string;
  readonly defaultReasoningEffort?: string;
  readonly supportedReasoningEfforts: readonly string[];
}
export interface ChatGptAuthStatus { readonly account: null | { readonly type?: string; readonly email?: string | null; readonly planType?: string | null }; readonly requiresOpenaiAuth: boolean; readonly pending: null | { readonly loginId: string; readonly verificationUrl: string; readonly userCode: string }; readonly lastCompletion?: unknown }
export interface ChatGptAuthTokens { readonly accessToken: string; readonly accountId: string; readonly plan?: string }

export class ChatGptAuthClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    if (!baseUrl || token.length < 32) throw new Error("ChatGPT auth broker URL and a 32-character token are required");
  }
  status(): Promise<ChatGptAuthStatus> { return this.request("/status"); }
  models(): Promise<unknown> { return this.request("/models"); }
  rateLimits(): Promise<unknown> { return this.request("/rate-limits"); }
  startDeviceLogin(): Promise<ChatGptAuthStatus> { return this.request("/device-login", "POST"); }
  cancelDeviceLogin(): Promise<ChatGptAuthStatus> { return this.request("/device-login/cancel", "POST"); }
  logout(): Promise<ChatGptAuthStatus> { return this.request("/logout", "POST"); }
  async tokens(refresh = false): Promise<ChatGptAuthTokens> {
    const value = await this.request<{ accessToken: string; chatgptAccountId: string; chatgptPlanType?: string | null }>("/tokens", "POST", { refresh });
    return { accessToken: value.accessToken, accountId: value.chatgptAccountId, ...(value.chatgptPlanType ? { plan: value.chatgptPlanType } : {}) };
  }
  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) throw new Error(`ChatGPT auth broker ${path} failed (${response.status}): ${String(payload.error ?? "unknown error")}`);
    return payload as T;
  }
}

export function openAiCodexProfile(model: string, reasoningEffort: string): CodexRuntimeProfile {
  const providerConfigToml = [`model = ${JSON.stringify(model)}`, 'model_provider = "openai"', `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`, ""].join("\n");
  const configToml = renderCodexConfig(providerConfigToml, [], OPENLEEK_CONTEXT_COMPACTION_POLICY, false);
  return { model, provider: "openai", reasoningEffort, providerConfigToml, modelsJson: "", configDigest: sha256({ configToml }) };
}
