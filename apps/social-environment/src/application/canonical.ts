import { createHash } from "node:crypto";

/** Canonical JSON used only for Social's durable checkpoint contents. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalise(record[key])]),
    );
  }
  return value;
}
