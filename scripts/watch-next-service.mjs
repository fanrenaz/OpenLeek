import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const packageName = required("OPENLEEK_APP_PACKAGE");
const appDir = required("OPENLEEK_APP_DIR");
const runtimeAppDir = process.env.OPENLEEK_RUNTIME_APP_DIR ?? appDir;
const paths = required("OPENLEEK_WATCH_PATHS").split(",").map((value) => value.trim()).filter(Boolean);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = process.env.PORT ?? "3000";
let child;
let restartTimer;
let restartChain = Promise.resolve();
let stopping = false;

const watchers = paths.map((path) => {
  const watcher = watch(path, { recursive: path !== appDir }, (_event, filename) => {
    if (!filename || ignored(filename)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartChain = restartChain
        .then(() => restart(filename))
        .catch((error) => console.error(`[openleek-watch] ${packageName}: restart failed: ${error.message}`));
    }, 180);
  });
  watcher.on("error", (error) => console.error(`[openleek-watch] ${path}: ${error.message}`));
  return watcher;
});

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
start();

function start() {
  if (stopping || child) return;
  prepareRuntimeApp();
  const spawned = spawn("/app/node_modules/.bin/next", ["dev", "--hostname", hostname, "--port", port], {
    cwd: runtimeAppDir,
    detached: true,
    env: process.env,
    stdio: "inherit",
  });
  child = spawned;
  spawned.once("exit", (code, signal) => {
    if (child !== spawned) return;
    child = undefined;
    if (stopping) return;
    console.error(`[openleek-watch] ${packageName} exited (${signal ?? code}); restarting`);
    restartTimer = setTimeout(start, 500);
  });
}

async function restart(filename) {
  console.log(`[openleek-watch] ${packageName}: ${filename} changed`);
  await stopChild();
  start();
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await stopChild();
  process.exit(signal === "SIGTERM" ? 0 : 130);
}

async function stopChild() {
  const current = child;
  if (!current?.pid) return;
  child = undefined;
  const exited = new Promise((resolve) => current.once("exit", resolve));
  signalGroup(current.pid, "SIGTERM");
  const timeout = setTimeout(() => signalGroup(current.pid, "SIGKILL"), 5_000);
  await exited;
  clearTimeout(timeout);
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function ignored(filename) {
  return filename.split(/[\\/]/).some((part) =>
    part.startsWith(".next")
    || part === "next-env.d.ts"
    || part === "tsconfig.tsbuildinfo"
    || part === "node_modules"
    || part === "coverage"
  );
}

function prepareRuntimeApp() {
  if (runtimeAppDir === appDir) return;
  mkdirSync(runtimeAppDir, { recursive: true });
  for (const filename of ["package.json", "next.config.ts", "tsconfig.json"]) {
    copyFileSync(join(appDir, filename), join(runtimeAppDir, filename));
  }
  const runtimeTsconfig = join(runtimeAppDir, "tsconfig.json");
  writeFileSync(runtimeTsconfig, readFileSync(runtimeTsconfig, "utf8").replace("../../tsconfig.base.json", "/app/tsconfig.base.json"));
  ensureLink(join(appDir, "src"), join(runtimeAppDir, "src"));
  ensureLink(join(appDir, "node_modules"), join(runtimeAppDir, "node_modules"));
  if (existsSync(join(appDir, "public"))) ensureLink(join(appDir, "public"), join(runtimeAppDir, "public"));
}

function ensureLink(target, path) {
  if (!existsSync(path)) symlinkSync(target, path, "dir");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
