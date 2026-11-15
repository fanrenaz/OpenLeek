import { Pool } from "pg";
import { ContextGateway, type GatewayStore, type StoredBinding } from "./gateway";
let singleton: Promise<ContextGateway> | undefined;
export function gateway() { return singleton ??= create(); }
async function create() {
  const registryUrl = required("OPENLEEK_CONTEXT_REGISTRY_URL"); const managementToken = required("OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN");
  const resolveInstallation = async (ref: string) => { const response = await fetch(new URL(`/internal/installations/${encodeURIComponent(ref)}`, registryUrl), { headers: { authorization: `Bearer ${managementToken}` } }); if (!response.ok) throw new Error(`Registry resolution failed with HTTP ${response.status}`); return await response.json() as { installation: { endpoint: string; contextId: string }; bearerToken: string }; };
  if (process.env.OPENLEEK_CONTEXT_GATEWAY_IN_MEMORY === "true") return new ContextGateway(new MemoryGatewayStore(), resolveInstallation);
  const pool = new Pool({ connectionString: required("OPENLEEK_CONTEXT_GATEWAY_DATABASE_URL"), max: 10 });
  await pool.query(`CREATE TABLE IF NOT EXISTS context_gateway_bindings (token_digest text PRIMARY KEY, run_id text NOT NULL, record jsonb NOT NULL); CREATE INDEX IF NOT EXISTS context_gateway_bindings_run_idx ON context_gateway_bindings (run_id)`);
  const store: GatewayStore = {
    async find(token) { return (await pool.query<{ record: StoredBinding }>("SELECT record FROM context_gateway_bindings WHERE token_digest = $1", [token])).rows[0]?.record; },
    async save(value) { await pool.query("INSERT INTO context_gateway_bindings (token_digest, run_id, record) VALUES ($1,$2,$3) ON CONFLICT (token_digest) DO UPDATE SET record=EXCLUDED.record", [value.tokenDigest, value.runId, value]); },
    async revokeRun(runId) { const result = await pool.query<{ token_digest: string; record: StoredBinding }>("SELECT token_digest, record FROM context_gateway_bindings WHERE run_id=$1", [runId]); for (const row of result.rows) await pool.query("UPDATE context_gateway_bindings SET record=$2 WHERE token_digest=$1", [row.token_digest, { ...row.record, revoked: true }]); },
  };
  return new ContextGateway(store, resolveInstallation);
}
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
export class MemoryGatewayStore implements GatewayStore { rows = new Map<string, StoredBinding>(); async find(key: string) { return this.rows.get(key); } async save(value: StoredBinding) { this.rows.set(value.tokenDigest, structuredClone(value)); } async revokeRun(runId: string) { for (const [key, value] of this.rows) if (value.runId === runId) this.rows.set(key, { ...value, revoked: true }); } }
