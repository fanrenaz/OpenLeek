import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  main: "infra/docker-compose.contexts.yml",
  mainPrebuilt: "infra/docker-compose.prebuilt.yml",
  financial: "infra/docker-compose.financial.yml",
  financialPrebuilt: "infra/docker-compose.financial.prebuilt.yml",
  social: "infra/docker-compose.social.yml",
  socialPrebuilt: "infra/docker-compose.social.prebuilt.yml",
  news: "infra/docker-compose.news.yml",
  newsPrebuilt: "infra/docker-compose.news.prebuilt.yml",
};
const source = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), "utf8")]));
const startup = readFileSync(resolve(root, "scripts/compose-up.mjs"), "utf8");
const redisEntrypoint = readFileSync(resolve(root, "infra/start-redis.sh"), "utf8");

for (const service of ["postgres", "redis", "neo4j", "context-registry", "context-gateway", "context-provisioner", "llm-configuration", "hindsight", "docker-socket-proxy", "agent-execution", "algorithm-runner", "experiment", "experiment-worker", "console"]) requireService(source.main, service, "main");
for (const service of ["financial-market", "financial-market-worker"]) requireService(source.financial, service, "financial");
for (const service of ["social-environment", "social-environment-worker"]) requireService(source.social, service, "social");
requireService(source.news, "news-context", "news");
for (const forbidden of ["financial-market", "financial-market-worker", "social-environment", "social-environment-worker"]) {
  if (new RegExp(`^  ${forbidden}:`, "m").test(source.main)) fail(`${forbidden} must not remain in the main Compose project`);
}
if (!source.main.startsWith("name: openleek\n") || !source.financial.startsWith("name: openleek-financial\n") || !source.social.startsWith("name: openleek-social\n") || !source.news.startsWith("name: openleek-news\n")) fail("Compose project names are not deterministic");

for (const marker of ["openleek-core-data", "openleek-financial-data", "openleek-social-data", "openleek-core-context-plugins", "openleek-core-financial", "openleek-core-social", "openleek-docker-control", "openleek-sandbox-control", "openleek-run-egress"]) {
  if (!source.main.includes(marker)) fail(`main Compose is missing ${marker}`);
}
for (const [context, compose] of [["financial", source.financial], ["social", source.social], ["news", source.news]]) {
  if (!compose.includes(`openleek-${context}-data`) || !compose.includes(`openleek-core-${context}`)) fail(`${context} network boundary is incomplete`);
  if (!compose.includes("openleek-core-context-plugins")) fail(`${context} project is missing the generic Context plugin plane`);
  if (!compose.includes("external: true")) fail(`${context} project must consume external data/Core networks`);
}
for (const service of ["experiment", "experiment-worker", "context-registry", "context-gateway", "console"]) {
  const section = serviceSection(source.main, service);
  if (!section.includes("core-context-plugins")) fail(`${service} must join the generic Context plugin plane`);
}
if (!source.main.includes("openleek-sandbox-context-gateway") || source.financial.includes("sandbox-financial") || source.social.includes("sandbox-social")) fail("Agent Context traffic must traverse only the shared Context Gateway network");
if (!source.main.includes("OPENLEEK_SANDBOX_CONTROL_NETWORK") || !source.main.includes("OPENLEEK_SANDBOX_CONTEXT_NETWORK") || source.main.includes("OPENLEEK_SANDBOX_NETWORK:")) fail("Run-scoped Context Gateway network configuration is incomplete");
if (!source.main.includes("name: openleek_openleek_postgres") || !source.main.includes("name: openleek_openleek_redis") || !source.main.includes("name: openleek_openleek_neo4j")) fail("existing persistent volume names must be pinned");
if (!redisEntrypoint.includes("user admin") || !redisEntrypoint.includes("user financial") || !redisEntrypoint.includes("~financial-market:*") || !redisEntrypoint.includes("user social") || !redisEntrypoint.includes("~social:*") || !redisEntrypoint.includes("user default on nopass -@all +ping")) fail("Redis ACL boundaries are incomplete");

for (const [compose, services] of [[source.mainPrebuilt, ["context-registry", "context-gateway", "context-provisioner", "llm-configuration", "agent-execution", "experiment", "experiment-worker", "console"]], [source.financialPrebuilt, ["financial-market", "financial-market-worker"]], [source.socialPrebuilt, ["social-environment", "social-environment-worker"]], [source.newsPrebuilt, ["news-context"]]]) {
  for (const service of services) {
    const app = service.endsWith("-worker") ? service.slice(0, -"-worker".length) : service;
    const section = serviceSection(compose, service);
    if (!section.includes(`/prebuilt/apps/${app}/server.js`) || !section.includes("NODE_ENV: production") || !section.includes("volumes: !override")) fail(`${service} must run its immutable prebuilt artifact`);
  }
  if (compose.includes("next dev") || compose.includes("watch-next-service")) fail("prebuilt Compose must not enable development runtimes");
}

for (const required of Object.values(paths)) if (!startup.includes(required)) fail(`compose:up does not load ${required}`);
for (const project of ["openleek", "openleek-financial", "openleek-social", "openleek-news"]) if (!startup.includes(`\"${project}\"`)) fail(`compose:up is missing project ${project}`);
if (!startup.includes("--remove-orphans") || !startup.includes("--force-recreate") || !startup.includes("requirePrebuiltRelease")) fail("production reconciliation safeguards are incomplete");

const env = {
  ...process.env,
  OPENLEEK_EXPERIMENT_CREDENTIAL_PRIVATE_KEY: "dev-only-private-key",
  OPENLEEK_EXPERIMENT_CREDENTIAL_PUBLIC_KEY: "dev-only-public-key",
  DEEPSEEK_API_KEY: "dev-only-deepseek-key",
  OPENAI_BASE_URL: "https://example.invalid/v1",
  OPENAI_API_KEY: "dev-only-memory-key",
  OPENLEEK_LLM_ROUTER_DEFAULT_MODEL: "memory-model",
  OPENLEEK_SANDBOX_RUNS_HOST_PATH: "/tmp/openleek-sandbox-runs",
  OPENLEEK_SANDBOX_APP_SERVER_TOKEN: "dev-only-compose-shape-token",
  OPENLEEK_CONSOLE_ACCESS_PASSWORD: "dev-only-console-password",
  OPENLEEK_CONSOLE_ACCESS_SESSION_SECRET: "dev-only-console-session-secret",
  OPENLEEK_PREBUILT_ROOT: "/tmp/openleek-prebuilt-shape",
};
composeConfig([paths.main, paths.mainPrebuilt], env);
composeConfig([paths.financial, paths.financialPrebuilt], env);
composeConfig([paths.social, paths.socialPrebuilt], env);
composeConfig([paths.news, paths.newsPrebuilt], env);
console.log("four-project prebuilt topology, Context Gateway network, and shared-data ACLs are structurally isolated");

function composeConfig(files, env) {
  const args = ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--quiet"];
  execFileSync("docker", args, { cwd: root, env, stdio: "pipe" });
}
function requireService(compose, service, project) { if (!new RegExp(`^  ${service}:`, "m").test(compose)) fail(`${project} project is missing ${service}`); }
function serviceSection(compose, service) { return compose.match(new RegExp(`^  ${service}:([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:|(?![\\s\\S]))`, "m"))?.[1] ?? ""; }
function fail(message) { console.error(message); process.exit(1); }
