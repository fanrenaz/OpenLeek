export type FinancialErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "RETRYABLE"
  | "INTERNAL";

/**
 * Context errors retain stable OpenLeek codes. The main shared tRPC formatter
 * can turn this error into the common wire representation without inspecting
 * HTTP status codes.
 */
export class FinancialMarketError extends Error {
  readonly code: FinancialErrorCode;
  readonly fieldViolations: ReadonlyArray<{ field: string; message: string }>;

  constructor(
    code: FinancialErrorCode,
    message: string,
    fieldViolations: ReadonlyArray<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "FinancialMarketError";
    this.code = code;
    this.fieldViolations = fieldViolations;
  }
}

export function invalid(message: string, field?: string): FinancialMarketError {
  return new FinancialMarketError(
    "INVALID_ARGUMENT",
    message,
    field === undefined ? [] : [{ field, message }],
  );
}

export function precondition(message: string): FinancialMarketError {
  return new FinancialMarketError("PRECONDITION_FAILED", message);
}

export function notFound(message: string): FinancialMarketError {
  return new FinancialMarketError("NOT_FOUND", message);
}

export function idempotencyConflict(message: string): FinancialMarketError {
  return new FinancialMarketError("IDEMPOTENCY_CONFLICT", message);
}
