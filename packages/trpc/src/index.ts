import { type DomainErrorCode, domainErrorDataSchema } from "@openleek/contracts/core";
import { observeProcedure } from "@openleek/observability";
import { httpBatchLink, createTRPCProxyClient } from "@trpc/client";
import { TRPCError, initTRPC, type AnyRouter } from "@trpc/server";
import { z } from "zod";

export class OpenLeekDomainError extends Error {
  readonly detail: z.infer<typeof domainErrorDataSchema>;

  constructor(detail: z.input<typeof domainErrorDataSchema>) {
    const parsed = domainErrorDataSchema.parse(detail);
    super(parsed.message);
    this.name = "OpenLeekDomainError";
    this.detail = parsed;
  }
}

const trpcCodeFor: Record<DomainErrorCode, TRPCError["code"]> = {
  INVALID_ARGUMENT: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  RETRYABLE: "SERVICE_UNAVAILABLE",
  INTERNAL: "INTERNAL_SERVER_ERROR",
};

export function asTRPCError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof OpenLeekDomainError) {
    return new TRPCError({ code: trpcCodeFor[error.detail.code], message: error.detail.message, cause: error });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Internal OpenLeek error", cause: error });
}

/** Shared root builder. Contexts add their own authentication/session data. */
export const t = initTRPC.context<object>().create({
  errorFormatter({ shape, error }) {
    const domain = error.cause instanceof OpenLeekDomainError
      ? error.cause.detail
      : { code: "INTERNAL" as const, message: "Internal OpenLeek error", violations: [] };
    return {
      ...shape,
      data: {
        ...shape.data,
        domainCode: domain.code,
        safeMessage: domain.message,
        violations: domain.violations,
        retryAfterMs: domain.retryAfterMs,
      },
    };
  },
});

/** Normalize thrown domain failures without coupling one Context to another router. */
export const domainProcedure = t.procedure.use(async ({ getRawInput, next, path, type }) => {
  const rawInput = await getRawInput();
  return observeProcedure({ path, type, rawInput }, next);
}).use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw asTRPCError(error);
  }
});

export function createContextClient<TRouter extends AnyRouter>(baseUrl: string) {
  return createTRPCProxyClient<TRouter>({
    // This generic helper intentionally supports Context routers configured
    // with either the identity transformer or a future shared transformer.
    // tRPC cannot infer that choice from an unconstrained router generic.
    links: [httpBatchLink({ url: new URL("/api/trpc", baseUrl).toString() } as never)],
  });
}
