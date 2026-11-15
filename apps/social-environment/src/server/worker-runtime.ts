export interface SocialWorkerRuntimeConfig { enabled: boolean; redisUrl?: string }
export function socialWorkerRuntimeConfig(environment: Readonly<Record<string, string | undefined>> = process.env): SocialWorkerRuntimeConfig {
  const enabled = environment.OPENLEEK_SOCIAL_ENVIRONMENT_WORKER === "true";
  const redisUrl = environment.OPENLEEK_REDIS_URL;
  if (enabled && !redisUrl) throw new Error("OPENLEEK_REDIS_URL is required when OPENLEEK_SOCIAL_ENVIRONMENT_WORKER=true");
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) throw new Error("OPENLEEK_REDIS_URL must use redis:// or rediss://");
  return { enabled, ...(redisUrl ? { redisUrl } : {}) };
}
