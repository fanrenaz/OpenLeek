const encoder = new TextEncoder();

export const consoleAccessCookie = "openleek_console_access";
export const consoleAccessSessionLifetimeSeconds = 180 * 24 * 60 * 60;

function encodeBase64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function hmac(value: string, sessionSecret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function consoleAccessConfiguration() {
  return {
    password: process.env["OPENLEEK_CONSOLE_ACCESS_PASSWORD"],
    sessionSecret: process.env["OPENLEEK_CONSOLE_ACCESS_SESSION_SECRET"],
  };
}

export async function passwordMatches(submitted: string, expected: string) {
  const [submittedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(submitted)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return equalBytes(new Uint8Array(submittedDigest), new Uint8Array(expectedDigest));
}

function effectiveSessionSecret(sessionSecret: string, password?: string) {
  return password === undefined ? sessionSecret : `${sessionSecret}\u0000${password}`;
}

export async function createConsoleAccessSession(sessionSecret: string, password?: string) {
  const payload = encodeBase64Url(JSON.stringify({ expiresAt: Math.floor(Date.now() / 1000) + consoleAccessSessionLifetimeSeconds }));
  return `${payload}.${encodeBase64Url(await hmac(payload, effectiveSessionSecret(sessionSecret, password)))}`;
}

export async function hasValidConsoleAccessSession(session: string | undefined, sessionSecret: string | undefined, password?: string) {
  if (!session || !sessionSecret) return false;
  const [payload, signature, ...extra] = session.split(".");
  if (!payload || !signature || extra.length > 0) return false;

  try {
    const expectedSignature = await hmac(payload, effectiveSessionSecret(sessionSecret, password));
    if (!equalBytes(decodeBase64Url(signature), expectedSignature)) return false;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as { expiresAt?: unknown };
    return typeof claims.expiresAt === "number" && claims.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}
