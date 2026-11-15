import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const codexHome = process.env.CODEX_HOME ?? "/var/lib/codex";
const capabilityToken = process.env.OPENLEEK_CHATGPT_AUTH_BROKER_TOKEN ?? "";
const port = positiveInteger(process.env.OPENLEEK_CHATGPT_AUTH_BROKER_PORT, 4502);
if (capabilityToken.length < 32) throw new Error("OPENLEEK_CHATGPT_AUTH_BROKER_TOKEN must contain at least 32 characters");

await mkdir(codexHome, { recursive: true, mode: 0o700 });
await writeConfigIfMissing();

const child = spawn("codex", ["app-server", "--stdio"], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "inherit"],
});
let buffer = "";
let nextId = 1;
let ready = false;
let pendingLogin = null;
let lastCompletion = null;
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) onMessage(line);
  }
});
child.on("exit", (code, signal) => {
  ready = false;
  const error = new Error(`Codex auth broker app-server exited (${code ?? signal ?? "unknown"})`);
  for (const operation of pending.values()) operation.reject(error);
  pending.clear();
});

await rpc("initialize", {
  clientInfo: { name: "openleek-chatgpt-auth-broker", title: "OpenLeek ChatGPT Auth Broker", version: "1.0.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
send({ method: "initialized", params: {} });
ready = true;

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") return json(response, ready ? 200 : 503, { status: ready ? "ok" : "not_ready" });
    if (!authorized(request.headers.authorization)) return json(response, 401, { error: "unauthorized" });
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/status") {
      const account = await rpc("account/read", { refreshToken: false });
      return json(response, 200, { ...publicAccount(account), pending: pendingLogin, lastCompletion });
    }
    if (request.method === "GET" && url.pathname === "/models") {
      const result = await rpc("model/list", {
        cursor: url.searchParams.get("cursor"),
        limit: positiveInteger(url.searchParams.get("limit") ?? undefined, 100),
        includeHidden: false,
      });
      return json(response, 200, result);
    }
    if (request.method === "GET" && url.pathname === "/rate-limits") {
      return json(response, 200, await rpc("account/rateLimits/read", {}));
    }
    if (request.method === "POST" && url.pathname === "/device-login") {
      if (pendingLogin) return json(response, 200, { ...publicAccount(await rpc("account/read", { refreshToken: false })), pending: pendingLogin, lastCompletion });
      const result = await rpc("account/login/start", { type: "chatgptDeviceCode" });
      if (!isRecord(result) || result.type !== "chatgptDeviceCode" || typeof result.loginId !== "string" || typeof result.verificationUrl !== "string" || typeof result.userCode !== "string") {
        throw new Error("Codex returned an invalid device authorization response");
      }
      pendingLogin = { loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode };
      lastCompletion = null;
      return json(response, 200, { ...publicAccount(await rpc("account/read", { refreshToken: false })), pending: pendingLogin, lastCompletion });
    }
    if (request.method === "POST" && url.pathname === "/device-login/cancel") {
      if (!pendingLogin) return json(response, 200, { ...publicAccount(await rpc("account/read", { refreshToken: false })), pending: null, lastCompletion });
      await rpc("account/login/cancel", { loginId: pendingLogin.loginId });
      pendingLogin = null;
      return json(response, 200, { ...publicAccount(await rpc("account/read", { refreshToken: false })), pending: null, lastCompletion });
    }
    if (request.method === "POST" && url.pathname === "/logout") {
      await rpc("account/logout", {});
      pendingLogin = null;
      lastCompletion = null;
      return json(response, 200, { ...publicAccount(await rpc("account/read", { refreshToken: false })), pending: null, lastCompletion });
    }
    if (request.method === "POST" && url.pathname === "/tokens") {
      const body = await bodyJson(request);
      const accountResult = await rpc("account/read", { refreshToken: body.refresh === true });
      const account = publicAccount(accountResult).account;
      if (!account || account.type !== "chatgpt") return json(response, 409, { error: "chatgpt_not_authorized" });
      const stored = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
      const tokens = isRecord(stored.tokens) ? stored.tokens : {};
      if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string") throw new Error("ChatGPT auth cache is incomplete");
      return json(response, 200, {
        accessToken: tokens.access_token,
        chatgptAccountId: tokens.account_id,
        chatgptPlanType: typeof account.planType === "string" ? account.planType : null,
      });
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    return json(response, 500, { error: safeError(error) });
  }
});
server.listen(port, "0.0.0.0");

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex auth broker request timed out: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function onMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!isRecord(message)) return;
  if (message.method === "account/login/completed" && isRecord(message.params)) {
    const loginId = typeof message.params.loginId === "string" ? message.params.loginId : null;
    lastCompletion = {
      loginId,
      success: message.params.success === true,
      error: typeof message.params.error === "string" ? message.params.error : null,
    };
    if (!pendingLogin || pendingLogin.loginId === loginId) pendingLogin = null;
    return;
  }
  if (typeof message.id !== "number") return;
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  clearTimeout(operation.timeout);
  if (isRecord(message.error)) operation.reject(new Error(`Codex app-server error ${String(message.error.code)}: ${String(message.error.message)}`));
  else operation.resolve(message.result);
}

async function writeConfigIfMissing() {
  const path = join(codexHome, "config.toml");
  const content = [
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    'include_environment_context = false',
    '',
    '[features]',
    'goals = false',
    'multi_agent = false',
    '',
  ].join("\n");
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
}

function publicAccount(value) {
  const result = isRecord(value) ? value : {};
  const raw = isRecord(result.account) ? result.account : null;
  const account = raw ? {
    type: raw.type,
    email: typeof raw.email === "string" ? raw.email : null,
    planType: typeof raw.planType === "string" ? raw.planType : null,
  } : null;
  return { account, requiresOpenaiAuth: result.requiresOpenaiAuth === true };
}

async function bodyJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16_384) throw new Error("request_body_too_large");
  }
  if (!text) return {};
  const value = JSON.parse(text);
  if (!isRecord(value)) throw new Error("request_body_must_be_object");
  return value;
}

function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(capabilityToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:eyJ|sk-)[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 500);
}

function positiveInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("invalid_positive_integer");
  return value;
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

process.on("SIGTERM", () => { child.kill("SIGTERM"); server.close(); });
process.on("SIGINT", () => { child.kill("SIGINT"); server.close(); });
