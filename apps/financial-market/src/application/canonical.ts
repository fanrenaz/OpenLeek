import { createHash } from "node:crypto";

/**
 * Strict canonical JSON for Financial-owned durable state and checkpoints.
 * Shared contracts own the cross-context implementation; this implementation
 * intentionally keeps sorted keys and finite JSON numbers until it is wired
 * to that package. Financial domain values still enforce safe integers at
 * their admission boundaries; algorithm configuration may contain fractions.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical Financial values must be finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : normalize(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      result[key] = normalize(record[key]);
    }
    return result;
  }
  throw new TypeError(`unsupported canonical Financial value: ${typeof value}`);
}
