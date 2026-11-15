import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  anyContextDescriptorSchema,
  contextBootstrapBundleSchema,
  contextInstallationCreateSchema,
  contextInstallationSchema,
  type AnyContextDescriptor,
  type ContextBootstrapBundle,
  type ContextInstallation,
} from "@openleek/contracts/context";

export interface InstallationRow extends ContextInstallation { encryptedToken: string; descriptor?: AnyContextDescriptor }
export interface RegistryStore {
  list(): Promise<InstallationRow[]>;
  find(ref: string): Promise<InstallationRow | undefined>;
  save(row: InstallationRow): Promise<void>;
}

const transitions: Record<ContextInstallation["state"], readonly ContextInstallation["state"][]> = {
  draft: ["provisioned", "failed"], provisioned: ["active", "failed"], active: ["draining", "disabled", "failed"],
  draining: ["disabled", "failed"], disabled: ["active"], failed: ["draft", "provisioned"],
};

export class ContextRegistry {
  constructor(private readonly store: RegistryStore, private readonly key: Buffer, private readonly fetcher: typeof fetch = fetch) {
    if (key.length !== 32) throw new Error("Context Registry encryption key must be 32 bytes");
  }

  async list(): Promise<ContextInstallation[]> { return (await this.store.list()).map(publicRow); }
  async catalog(): Promise<AnyContextDescriptor[]> { return (await this.store.list()).filter((row) => row.state === "active" && row.descriptor).map((row) => structuredClone(row.descriptor!)).sort((left, right) => left.contextId.localeCompare(right.contextId)); }
  async get(ref: string): Promise<ContextInstallation> { return publicRow(await this.required(ref)); }

  async create(input: unknown): Promise<{ installation: ContextInstallation; bootstrap: ContextBootstrapBundle }> {
    const value = contextInstallationCreateSchema.parse(input);
    if (value.management === "self-managed" && new URL(value.endpoint).protocol !== "https:") throw new Error("self-managed Context endpoints must use HTTPS");
    const now = new Date().toISOString();
    const token = randomBytes(32).toString("base64url");
    const ref = `context-installation:${value.contextId}:${randomUUID()}`;
    const row: InstallationRow = { installationRef: ref, contextId: value.contextId, endpoint: value.endpoint, state: "draft", management: value.management, infrastructure: value.infrastructure, createdAt: now, updatedAt: now, encryptedToken: encrypt(token, this.key) };
    await this.store.save(row);
    return {
      installation: publicRow(row),
      bootstrap: contextBootstrapBundleSchema.parse({ installationRef: ref, bearerToken: token, environment: { OPENLEEK_CONTEXT_INSTALLATION_REF: ref, OPENLEEK_CONTEXT_BEARER_TOKEN: token } }),
    };
  }

  /** Idempotently adopts a platform-shipped Context whose credential comes
   * from deployment configuration and is never returned to a browser. */
  async ensureBuiltin(input: { installationRef: string; contextId: string; endpoint: string; bearerToken: string; infrastructure: ContextInstallation["infrastructure"] }): Promise<ContextInstallation> {
    const endpoint = new URL(input.endpoint).toString().replace(/\/$/, "");
    const existing = await this.store.find(input.installationRef);
    const now = new Date().toISOString();
    if (existing && existing.contextId !== input.contextId) throw new Error(`built-in installation '${input.installationRef}' belongs to another Context`);
    const row: InstallationRow = {
      ...(existing ?? {
        installationRef: input.installationRef,
        contextId: input.contextId,
        state: "provisioned" as const,
        management: "platform" as const,
        createdAt: now,
      }),
      endpoint,
      infrastructure: input.infrastructure,
      updatedAt: now,
      encryptedToken: encrypt(input.bearerToken, this.key),
    };
    await this.store.save(row);
    return publicRow(row);
  }

  async transition(ref: string, state: ContextInstallation["state"], failure?: string): Promise<ContextInstallation> {
    const current = await this.required(ref);
    if (!transitions[current.state].includes(state)) throw new Error(`invalid Context installation transition ${current.state} -> ${state}`);
    const next = { ...current, state, updatedAt: new Date().toISOString(), ...(failure ? { failure } : {}) };
    await this.store.save(next);
    return publicRow(next);
  }

  async verifyAndActivate(ref: string): Promise<ContextInstallation> {
    const current = await this.required(ref);
    if (current.state !== "provisioned" && current.state !== "disabled" && current.state !== "active") throw new Error("only provisioned, disabled, or active installations can be verified");
    const response = await this.fetcher(new URL("/api/context/v2/descriptor", current.endpoint), { headers: { authorization: `Bearer ${decrypt(current.encryptedToken, this.key)}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Context descriptor probe failed with HTTP ${response.status}`);
    const descriptor = anyContextDescriptorSchema.parse(await response.json()) as AnyContextDescriptor;
    if (descriptor.schemaVersion !== "3" || !("runtimeProtocol" in descriptor) || descriptor.runtimeProtocol !== "openleek-context-runtime/v2") throw new Error("Context installation must implement openleek-context-runtime/v2 with a v3 descriptor");
    if (descriptor.contextId !== current.contextId) throw new Error(`Context descriptor mismatch: expected ${current.contextId}, received ${descriptor.contextId}`);
    const next = { ...current, descriptorRevision: descriptor.revision, descriptor, state: "active" as const, updatedAt: new Date().toISOString(), failure: undefined };
    await this.store.save(next);
    return publicRow(next);
  }

  async resolve(ref: string): Promise<{ installation: ContextInstallation; bearerToken: string }> {
    const row = await this.required(ref);
    if (row.state !== "active" && row.state !== "draining") throw new Error(`Context installation '${ref}' is not routable`);
    return { installation: publicRow(row), bearerToken: decrypt(row.encryptedToken, this.key) };
  }

  private async required(ref: string) { const row = await this.store.find(ref); if (!row) throw new Error(`unknown Context installation '${ref}'`); return row; }
}

function publicRow(row: InstallationRow): ContextInstallation { const { encryptedToken: _secret, descriptor: _descriptor, ...value } = row; return contextInstallationSchema.parse(value); }
function encrypt(value: string, key: Buffer) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url"); }
function decrypt(value: string, key: Buffer) { const bytes = Buffer.from(value, "base64url"); const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); }
