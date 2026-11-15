import { Pool } from "pg";
import type { RegistryStore, InstallationRow } from "./registry";
import { ContextRegistry } from "./registry";

let singleton: Promise<ContextRegistry> | undefined;
export function contextRegistry() { return singleton ??= create(); }

async function create() {
  const keyHex = process.env.OPENLEEK_CONTEXT_REGISTRY_ENCRYPTION_KEY;
  if (!keyHex || !/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("OPENLEEK_CONTEXT_REGISTRY_ENCRYPTION_KEY must be 64 hexadecimal characters");
  if (process.env.OPENLEEK_CONTEXT_REGISTRY_IN_MEMORY === "true") return new ContextRegistry(new MemoryStore(), Buffer.from(keyHex, "hex"));
  const connectionString = process.env.OPENLEEK_CONTEXT_REGISTRY_DATABASE_URL;
  if (!connectionString) throw new Error("OPENLEEK_CONTEXT_REGISTRY_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 5 });
  await pool.query(`CREATE TABLE IF NOT EXISTS context_installations (installation_ref text PRIMARY KEY, record jsonb NOT NULL)`);
  const registry = new ContextRegistry({
    async list() { return (await pool.query<{ record: InstallationRow }>("SELECT record FROM context_installations ORDER BY installation_ref")).rows.map((row) => row.record); },
    async find(ref) { return (await pool.query<{ record: InstallationRow }>("SELECT record FROM context_installations WHERE installation_ref = $1", [ref])).rows[0]?.record; },
    async save(row) { await pool.query("INSERT INTO context_installations (installation_ref, record) VALUES ($1, $2) ON CONFLICT (installation_ref) DO UPDATE SET record = EXCLUDED.record", [row.installationRef, row]); },
  }, Buffer.from(keyHex, "hex"));
  const builtins = [
    { contextId: "social", endpoint: process.env.OPENLEEK_BUILTIN_SOCIAL_CONTEXT_URL ?? "http://social-environment:3000", bearerToken: process.env.OPENLEEK_BUILTIN_SOCIAL_CONTEXT_BEARER_TOKEN ?? "platform-social-descriptor", infrastructure: { postgres: true, redis: true } },
    { contextId: "financial", endpoint: process.env.OPENLEEK_BUILTIN_FINANCIAL_CONTEXT_URL ?? "http://financial-market:3000", bearerToken: process.env.OPENLEEK_BUILTIN_FINANCIAL_CONTEXT_BEARER_TOKEN ?? "platform-financial-descriptor", infrastructure: { postgres: true, redis: true } },
    { contextId: "news", endpoint: process.env.OPENLEEK_BUILTIN_NEWS_CONTEXT_URL ?? "http://news-context:3000", bearerToken: process.env.OPENLEEK_BUILTIN_NEWS_CONTEXT_BEARER_TOKEN, infrastructure: { postgres: true, redis: false } },
  ] as const;
  for (const builtin of builtins) if (builtin.bearerToken) {
    await registry.ensureBuiltin({ installationRef: `context-installation:${builtin.contextId}:builtin`, ...builtin, bearerToken: builtin.bearerToken });
  }
  return registry;
}

export class MemoryStore implements RegistryStore {
  readonly rows = new Map<string, InstallationRow>();
  async list() { return [...this.rows.values()].map((row) => structuredClone(row)); }
  async find(ref: string) { const row = this.rows.get(ref); return row && structuredClone(row); }
  async save(row: InstallationRow) { this.rows.set(row.installationRef, structuredClone(row)); }
}
