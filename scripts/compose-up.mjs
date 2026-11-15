import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.env.OPENLEEK_COMPOSE_ENV_FILE ?? ".env";
const prebuiltRoot = process.env.OPENLEEK_PREBUILT_ROOT ?? resolve(root, ".runtime/prebuilt/current");
const dryRun = process.argv.includes("--dry-run");
const selectedProject = process.argv.find((argument) => argument.startsWith("--project="))?.slice("--project=".length);
const appArmorProfileSource = resolve(root, "infra/apparmor/openleek-codex-userns");
const appArmorProfileTarget = "/etc/apparmor.d/openleek-codex-userns";
const common = ["compose", "--env-file", envFile];
const main = [...common, "--project-name", "openleek", "-f", "infra/docker-compose.contexts.yml", "-f", "infra/docker-compose.prebuilt.yml"];
const financial = [...common, "--project-name", "openleek-financial", "-f", "infra/docker-compose.financial.yml", "-f", "infra/docker-compose.financial.prebuilt.yml"];
const social = [...common, "--project-name", "openleek-social", "-f", "infra/docker-compose.social.yml", "-f", "infra/docker-compose.social.prebuilt.yml"];
const news = [...common, "--project-name", "openleek-news", "-f", "infra/docker-compose.news.yml", "-f", "infra/docker-compose.news.prebuilt.yml"];
const projectServices = {
  financial: ["financial-market", "financial-market-worker"],
  social: ["social-environment", "social-environment-worker"],
  news: ["news-context"],
};

if (!dryRun) requireWorkspaceDependencies();
if (!dryRun) requirePrebuiltRelease();
ensureCodexUserNamespaceProfile();

if (selectedProject) {
  const compose = selectedProject === "financial" ? financial : selectedProject === "social" ? social : selectedProject === "news" ? news : undefined;
  if (!compose) throw new Error(`unknown Compose project '${selectedProject}'`);
  run([...compose, "up", "--detach", "--wait", "--force-recreate", "--remove-orphans", ...projectServices[selectedProject]]);
  process.exit(0);
}

run(["build", "--tag", "openleek-codex-sandbox:local", "--file", "docker/codex-app-server.Dockerfile", "."]);
run([...main, "up", "--detach", "--wait", "postgres", "redis", "neo4j", "algorithm-runner", "chatgpt-auth-broker"]);
run([...main, "exec", "-T", "postgres", "/bin/sh", "/usr/local/bin/openleek-context-db-bootstrap"]);
stopLegacyContextContainers();
// The Gateway owns the shared Core/Agent network edges consumed as external
// networks by independently deployed Context projects.
run([...main, "up", "--detach", "--wait", "--force-recreate", "context-registry", "context-gateway", "context-provisioner"]);
run([...financial, "up", "--detach", "--wait", "--force-recreate", "--remove-orphans", ...projectServices.financial]);
run([...social, "up", "--detach", "--wait", "--force-recreate", "--remove-orphans", ...projectServices.social]);
run([...news, "up", "--detach", "--wait", "--force-recreate", "--remove-orphans", ...projectServices.news]);
for (const contextId of ["social", "financial", "news"]) {
  run([...main, "exec", "-T", "context-registry", "node", "-e", `fetch('http://127.0.0.1:3000/internal/installations/context-installation%3A${contextId}%3Abuiltin',{method:'PATCH',headers:{authorization:'Bearer '+process.env.OPENLEEK_CONTEXT_REGISTRY_MANAGEMENT_TOKEN,'content-type':'application/json'},body:JSON.stringify({action:'activate'})}).then(async r=>{if(!r.ok)throw new Error('built-in ${contextId} Context activation failed with HTTP '+r.status+': '+await r.text())}).catch(e=>{console.error(e.message);process.exit(1)})`]);
}
// Keep unchanged heavyweight dependencies in place; only application services
// selected from the new prebuilt release are force-recreated.
run([...main, "up", "--detach", "--wait", "llm-configuration", "hindsight", "algorithm-runner"]);
run([...main, "up", "--detach", "--wait", "--force-recreate",
  "context-registry", "context-gateway", "context-provisioner", "chatgpt-auth-broker", "agent-execution", "experiment", "experiment-worker", "console"]);
run([...main, "up", "--detach", "--wait", "--remove-orphans"]);

function stopLegacyContextContainers() {
  if (dryRun) return;
  for (const service of [...projectServices.financial, ...projectServices.social, ...projectServices.news]) {
    const result = spawnSync("docker", ["ps", "--quiet", "--filter", "label=com.docker.compose.project=openleek", "--filter", `label=com.docker.compose.service=${service}`], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) run(["stop", "--time", "30", ...ids]);
  }
}

function requireWorkspaceDependencies() {
  const installedLock = resolve(root, "node_modules/.pnpm/lock.yaml");
  const workspaceLock = resolve(root, "pnpm-lock.yaml");
  const nextBinary = resolve(root, "node_modules/.bin/next");
  if (!existsSync(installedLock) || !existsSync(nextBinary) || readFileSync(installedLock, "utf8") !== readFileSync(workspaceLock, "utf8")) {
    console.error("Workspace dependencies are missing or stale. Run: pnpm install --frozen-lockfile");
    process.exit(1);
  }
}

function requirePrebuiltRelease() {
  for (const app of ["context-registry", "context-gateway", "context-provisioner", "news-context", "llm-configuration", "agent-execution", "social-environment", "financial-market", "experiment", "console"]) {
    const server = resolve(prebuiltRoot, app, "apps", app, "server.js");
    if (!existsSync(server)) {
      console.error(`Prebuilt release is missing ${server}. Run: pnpm build:prebuilt`);
      process.exit(1);
    }
  }
}

function ensureCodexUserNamespaceProfile() {
  if (process.platform !== "linux") return;
  const restrictionPath = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  if (!existsSync(restrictionPath) || readFileSync(restrictionPath, "utf8").trim() !== "1") return;
  runHost("sudo", ["-n", "install", "-m", "0644", appArmorProfileSource, appArmorProfileTarget]);
  runHost("sudo", ["-n", "apparmor_parser", "-r", appArmorProfileTarget]);
}

function runHost(command, args) {
  console.log(`${command} ${args.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function run(args) {
  console.log(`docker ${args.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync("docker", args, { cwd: root, env: { ...process.env, OPENLEEK_PREBUILT_ROOT: prebuiltRoot }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
