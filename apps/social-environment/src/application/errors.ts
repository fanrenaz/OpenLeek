export type SocialErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "RETRYABLE"
  | "INTERNAL";

export class SocialDomainError extends Error {
  readonly code: SocialErrorCode;
  readonly fieldViolations: Readonly<Record<string, string>>;

  constructor(
    code: SocialErrorCode,
    message: string,
    fieldViolations: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "SocialDomainError";
    this.code = code;
    this.fieldViolations = fieldViolations;
  }
}

export function invalidArgument(message: string, field?: string): SocialDomainError {
  return new SocialDomainError(
    "INVALID_ARGUMENT",
    message,
    field === undefined ? {} : { [field]: message },
  );
}
