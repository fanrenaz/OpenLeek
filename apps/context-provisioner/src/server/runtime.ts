import { Pool } from "pg";
import { ContextProvisioner, postgresAdmin, redisAdmin } from "./provisioner";
let singleton: ContextProvisioner | undefined;
export function provisioner() { if (singleton) return singleton; const postgresUrl = process.env.OPENLEEK_PROVISIONER_POSTGRES_ADMIN_URL; const redisPassword = process.env.OPENLEEK_REDIS_ADMIN_PASSWORD; singleton = new ContextProvisioner(postgresUrl ? postgresAdmin(new Pool({ connectionString: postgresUrl, max: 2 })) : undefined, redisPassword ? redisAdmin({ host: process.env.OPENLEEK_REDIS_HOST ?? "redis", port: Number(process.env.OPENLEEK_REDIS_PORT ?? 6379), password: redisPassword }) : undefined); return singleton; }
