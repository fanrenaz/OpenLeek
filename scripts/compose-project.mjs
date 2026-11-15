import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [project, operation] = process.argv.slice(2);
if (!(["financial", "social", "news"].includes(project) && ["up", "stop", "ps", "logs"].includes(operation))) {
  throw new Error("usage: compose-project.mjs <financial|social|news> <up|stop|ps|logs>");
}
if (operation === "up") {
  const result = spawnSync(process.execPath, ["scripts/compose-up.mjs", `--project=${project}`], { cwd: root, stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}
const envFile = process.env.OPENLEEK_COMPOSE_ENV_FILE ?? ".env";
const prebuiltRoot = process.env.OPENLEEK_PREBUILT_ROOT ?? resolve(root, ".runtime/prebuilt/current");
const args = ["compose", "--env-file", envFile, "--project-name", `openleek-${project}`, "-f", `infra/docker-compose.${project}.yml`, "-f", `infra/docker-compose.${project}.prebuilt.yml`, operation];
if (operation === "logs") args.push("--tail", "200");
const result = spawnSync("docker", args, { cwd: root, stdio: "inherit", env: { ...process.env, OPENLEEK_PREBUILT_ROOT: prebuiltRoot } });
process.exit(result.status ?? 1);
