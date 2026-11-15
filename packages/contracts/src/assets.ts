import { z } from "zod";
import { identifierSchema } from "./core";

export const assetDeleteTargetSchema = z.enum(["draft", "version"]);
export type AssetDeleteTarget = z.infer<typeof assetDeleteTargetSchema>;

export const assetTombstoneSchema = z.object({
  assetKind: identifierSchema,
  assetId: identifierSchema,
  target: assetDeleteTargetSchema,
  deletedAt: z.string().datetime(),
  idempotencyKey: identifierSchema,
  expectedRevision: z.number().int().positive().optional(),
}).strict();
export type AssetTombstone = z.infer<typeof assetTombstoneSchema>;

export const deleteDraftInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: identifierSchema,
}).strict();

export const deleteVersionInputSchema = z.object({
  versionRef: identifierSchema,
  idempotencyKey: identifierSchema,
}).strict();

export const assetDeletionResultSchema = z.object({
  status: z.enum(["deleted", "already-deleted"]),
  replayed: z.boolean(),
  tombstone: assetTombstoneSchema,
}).strict();
export type AssetDeletionResult = z.infer<typeof assetDeletionResultSchema>;
