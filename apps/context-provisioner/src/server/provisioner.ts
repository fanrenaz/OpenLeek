import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { contextInfrastructureSchema } from "@openleek/contracts/context";
import { identifierSchema } from "@openleek/contracts/core";
import type { Pool } from "pg";
import { z } from "zod";

export const provisionInputSchema = z.object({ installationRef: identifierSchema, contextId: identifierSchema, infrastructure: contextInfrastructureSchema }).strict();
export interface ProvisionedResources { installationRef: string; environment: Record<string, string> }
export interface PostgresAdmin { provision(role: string, database: string, password: string): Promise<void> }
export interface RedisAdmin { provision(user: string, keyPrefix: string, password: string): Promise<void> }
export class ContextProvisioner {
  constructor(private readonly postgres?: PostgresAdmin, private readonly redis?: RedisAdmin) {}
  async provision(input: unknown): Promise<ProvisionedResources> {
    const value = provisionInputSchema.parse(input); const suffix = createHash("sha256").update(value.installationRef).digest("hex").slice(0, 12); const slug = value.contextId.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24); const environment: Record<string, string> = {};
    if (value.infrastructure.postgres) { if (!this.postgres) throw new Error("PostgreSQL provisioning is unavailable"); const password = randomBytes(24).toString("base64url"); const role = `ctx_${slug}_${suffix}`; const database = `ctx_${slug}_${suffix}`; await this.postgres.provision(role, database, password); environment.OPENLEEK_CONTEXT_DATABASE_URL = `postgresql://${role}:${password}@postgres:5432/${database}`; }
    if (value.infrastructure.redis) { if (!this.redis) throw new Error("Redis provisioning is unavailable"); const password = randomBytes(24).toString("base64url"); const user = `ctx_${slug}_${suffix}`; const prefix = `context:${suffix}:`; await this.redis.provision(user, prefix, password); environment.OPENLEEK_CONTEXT_REDIS_URL = `redis://${user}:${password}@redis:6379`; environment.OPENLEEK_CONTEXT_REDIS_PREFIX = prefix; }
    return { installationRef: value.installationRef, environment };
  }
}
export function postgresAdmin(pool: Pool): PostgresAdmin { return { async provision(role, database, password) { const quotedRole = quoteIdentifier(role); const quotedDatabase = quoteIdentifier(database); const roleExists = (await pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists", [role])).rows[0]?.exists; if (!roleExists) await pool.query(`CREATE ROLE ${quotedRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${quoteLiteral(password)}`); else await pool.query(`ALTER ROLE ${quotedRole} PASSWORD ${quoteLiteral(password)}`); const dbExists = (await pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS exists", [database])).rows[0]?.exists; if (!dbExists) await pool.query(`CREATE DATABASE ${quotedDatabase} OWNER ${quotedRole}`); await pool.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM PUBLIC`); await pool.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${quotedRole}`); } }; }
export function redisAdmin(input: { host: string; port: number; password: string }): RedisAdmin { return { async provision(user, prefix, password) { await redisCommands(input, [["AUTH", "admin", input.password], ["ACL", "SETUSER", user, "on", `>${password}`, `~${prefix}*`, "-@all", "+ping", "+xadd", "+xgroup", "+xreadgroup", "+xack", "+xautoclaim", "+xpending", "+xdel", "+del"]]); } }; }
function quoteIdentifier(value: string) { if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier"); return `"${value}"`; }
function quoteLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function redisCommands(input: { host: string; port: number }, commands: string[][]) { return new Promise<void>((resolve, reject) => { const socket = createConnection(input.port, input.host); let output = ""; socket.setTimeout(5_000); socket.on("connect", () => socket.write(commands.map((parts) => `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`).join(""))); socket.on("data", (chunk) => { output += chunk.toString(); if (output.split("\r\n").some((line) => line.startsWith("-"))) { socket.destroy(); reject(new Error(`Redis provisioning failed: ${output.trim()}`)); } else if (output.split("\r\n").filter((line) => line.startsWith("+")).length >= commands.length) { socket.end(); resolve(); } }); socket.on("timeout", () => socket.destroy(new Error("Redis provisioning timed out"))); socket.on("error", reject); }); }
