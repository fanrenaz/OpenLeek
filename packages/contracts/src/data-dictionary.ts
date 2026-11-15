import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { localizedTextSchema } from "./context";
import { identifierSchema } from "./core";

export const jsonSchemaDocumentSchema = z.record(z.string(), z.unknown());
export type JsonSchemaDocument = z.infer<typeof jsonSchemaDocumentSchema>;

export const dataDictionaryReferenceSchema = z.object({
  path: z.string().min(1).max(500),
  targetEntryId: identifierSchema,
  description: localizedTextSchema.optional(),
}).strict();

export const dataDictionaryExampleSchema = z.object({
  title: localizedTextSchema,
  description: localizedTextSchema.optional(),
  value: z.unknown(),
}).strict();

export const dataDictionaryEntryKindSchema = z.enum([
  "asset",
  "input",
  "aggregate",
  "projection",
  "evidence",
  "configuration",
]);
export type DataDictionaryEntryKind = z.infer<typeof dataDictionaryEntryKindSchema>;

export const dataDictionaryManagementCapabilitySchema = z.enum([
  "list",
  "read",
  "validate",
  "preview",
  "save-draft",
  "publish",
  "delete-draft",
  "delete-version",
  "create",
  "resume",
  "retry",
  "cancel",
  "fork",
  "patch",
  "create-resource",
  "delete-resource",
]);
export type DataDictionaryManagementCapability = z.infer<typeof dataDictionaryManagementCapabilitySchema>;

export const dataDictionaryManagementSchema = z.object({
  surface: z.enum(["asset-library", "run", "llm-configuration"]),
  key: identifierSchema,
  idField: identifierSchema.optional(),
  capabilities: z.array(dataDictionaryManagementCapabilitySchema).min(1).max(30),
}).strict();
export type DataDictionaryManagement = z.infer<typeof dataDictionaryManagementSchema>;

export const pythonMethodContractSchema = z.object({
  signature: z.string().min(1).max(500),
  description: localizedTextSchema,
}).strict();

export const pythonProgrammingContractSchema = z.object({
  language: z.literal("python"),
  className: z.string().min(1).max(100),
  constructor: z.string().min(1).max(500),
  methods: z.array(pythonMethodContractSchema).min(1).max(20),
  contextSchema: jsonSchemaDocumentSchema,
  resultSchema: jsonSchemaDocumentSchema,
  allowedImports: z.array(z.string().min(1).max(100)).max(100).default([]),
  limits: z.object({
    maxRuntimeMs: z.number().int().positive(),
    maxMemoryMb: z.number().int().positive(),
  }).strict(),
  exampleSource: z.string().min(1).max(250_000),
}).strict();

export const dataDictionaryEntrySchema = z.object({
  schemaVersion: z.literal("1"),
  id: identifierSchema,
  ownerId: identifierSchema,
  categoryId: identifierSchema,
  entryKind: dataDictionaryEntryKindSchema,
  management: dataDictionaryManagementSchema,
  label: localizedTextSchema,
  description: localizedTextSchema,
  definitionSchema: jsonSchemaDocumentSchema,
  references: z.array(dataDictionaryReferenceSchema).max(100).default([]),
  examples: z.array(dataDictionaryExampleSchema).max(20).default([]),
  programming: pythonProgrammingContractSchema.optional(),
}).strict();
export type DataDictionaryEntry = z.infer<typeof dataDictionaryEntrySchema>;

export const dataDictionarySourceSchema = z.object({
  schemaVersion: z.literal("1"),
  ownerId: identifierSchema,
  owner: localizedTextSchema,
  revision: identifierSchema,
  entries: z.array(dataDictionaryEntrySchema).max(200),
}).strict().superRefine((source, context) => {
  const ids = new Set<string>();
  source.entries.forEach((entry, index) => {
    if (entry.ownerId !== source.ownerId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "ownerId"],
        message: "must match source ownerId",
      });
    }
    if (ids.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "id"],
        message: "must be unique within a source",
      });
    }
    ids.add(entry.id);
  });
});
export type DataDictionarySource = z.infer<typeof dataDictionarySourceSchema>;

export const dataDictionarySourceResultSchema = z.object({
  ownerId: identifierSchema,
  owner: localizedTextSchema,
  available: z.boolean(),
  revision: identifierSchema.optional(),
  entries: z.array(dataDictionaryEntrySchema).max(200).default([]),
  error: z.string().min(1).max(1_000).optional(),
}).strict();

export const dataDictionaryCatalogSchema = z.object({
  schemaVersion: z.literal("1"),
  sources: z.array(dataDictionarySourceResultSchema).max(100),
}).strict().superRefine((catalog, context) => {
  const owners = new Set<string>();
  const entries = new Set<string>();
  catalog.sources.forEach((source, sourceIndex) => {
    if (owners.has(source.ownerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", sourceIndex, "ownerId"],
        message: "must be unique",
      });
    }
    owners.add(source.ownerId);
    source.entries.forEach((entry, entryIndex) => {
      if (entries.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", sourceIndex, "entries", entryIndex, "id"],
          message: "must be globally unique",
        });
      }
      entries.add(entry.id);
    });
  });
});
export type DataDictionaryCatalog = z.infer<typeof dataDictionaryCatalogSchema>;

/** Derive the dictionary document from the same Zod contract used at Owner API boundaries. */
export function toDataDictionaryJsonSchema(schema: z.ZodTypeAny): JsonSchemaDocument {
  return jsonSchemaDocumentSchema.parse(zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }));
}
