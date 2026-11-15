/** Stable domain failures are converted by this Context's tRPC boundary. */
export type AgentExecutionErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "RETRYABLE"
  | "INTERNAL";

export class AgentExecutionError extends Error {
  constructor(
    readonly code: AgentExecutionErrorCode,
    message: string,
    readonly violations: ReadonlyArray<{ readonly field: string; readonly message: string }> = [],
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

function fail(
  code: AgentExecutionErrorCode,
  message: string,
  violations: ReadonlyArray<{ readonly field: string; readonly message: string }> = [],
): never {
  throw new AgentExecutionError(code, message, violations);
}

export function invalidArgument(
  message: string,
  fields: Readonly<Record<string, string>> = {},
): never {
  return fail("INVALID_ARGUMENT", message, Object.entries(fields).map(([field, detail]) => ({ field, message: detail })));
}

export function notFound(message: string): never {
  return fail("NOT_FOUND", message);
}

export function preconditionFailed(message: string): never {
  return fail("PRECONDITION_FAILED", message);
}

export function idempotencyConflict(message: string): never {
  return fail("IDEMPOTENCY_CONFLICT", message);
}

export function retryable(message: string, _cause?: unknown): never {
  return fail("RETRYABLE", message);
}
