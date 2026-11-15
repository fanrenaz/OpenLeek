import { spawnSync } from "node:child_process";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real Compose sandbox E2E`);
  return value;
}

if (process.env.OPENLEEK_RUN_SANDBOX_E2E !== "1") {
  throw new Error("refusing to run provider E2E: set OPENLEEK_RUN_SANDBOX_E2E=1");
}
required("DEEPSEEK_API_KEY");
required("OPENLEEK_SANDBOX_APP_SERVER_TOKEN");
const composeEnvFile = process.env.OPENLEEK_COMPOSE_ENV_FILE ?? ".env";

const compose = spawnSync("docker", ["compose", "--env-file", composeEnvFile, "--project-name", "openleek", "-f", "infra/docker-compose.contexts.yml", "-f", "infra/docker-compose.prebuilt.yml", "ps", "--status", "running"], { stdio: "inherit", env: { ...process.env, OPENLEEK_PREBUILT_ROOT: process.env.OPENLEEK_PREBUILT_ROOT ?? ".runtime/prebuilt/current" } });
if (compose.status !== 0) throw new Error("the real E2E requires an already-running Compose topology");

const playwright = spawnSync(process.execPath, ["./node_modules/@playwright/test/cli.js", "test", "e2e/console.spec.ts"], {
  stdio: "inherit",
  env: process.env,
});
process.exitCode = playwright.status ?? 1;
