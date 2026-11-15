import { z } from "zod";

/** Runtime-validated, context-neutral identifiers. */
export const identifierSchema = z.string().min(1).max(240);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 digest");
export const opaqueCursorSchema = z.string().min(1).max(8_192);

export const domainErrorCodeSchema = z.enum([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PRECONDITION_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "RETRYABLE",
  "INTERNAL",
]);
export type DomainErrorCode = z.infer<typeof domainErrorCodeSchema>;

export const fieldViolationSchema = z.object({
  field: z.string().min(1),
  message: z.string().min(1),
});

export const domainErrorDataSchema = z.object({
  code: domainErrorCodeSchema,
  message: z.string().min(1),
  violations: z.array(fieldViolationSchema).default([]),
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type DomainErrorData = z.infer<typeof domainErrorDataSchema>;

/** Required on every mutation. Empty expectedCheckpointRef is initialization-only. */
export const mutationHeaderSchema = z.object({
  transitionId: identifierSchema,
  stepId: identifierSchema,
  payloadDigest: digestSchema,
  expectedCheckpointRef: z.string().max(240),
});
export type MutationHeader = z.infer<typeof mutationHeaderSchema>;

export const operationReceiptSchema = z.object({
  transitionId: identifierSchema,
  stepId: identifierSchema,
  requestDigest: digestSchema,
  resultDigest: digestSchema,
  replayed: z.boolean(),
});

export const pageInputSchema = z.object({
  cursor: opaqueCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const pageInfoSchema = z.object({ nextCursor: opaqueCursorSchema.optional() });

/** `market_maker` is a deterministic Financial Market policy, never a research agent. */

export function parseMutationHeader(input: unknown, options: { initialization?: boolean } = {}): MutationHeader {
  const header = mutationHeaderSchema.parse(input);
  if (!options.initialization && !header.expectedCheckpointRef) {
    throw new Error("expectedCheckpointRef is required after initialization");
  }
  return header;
}
