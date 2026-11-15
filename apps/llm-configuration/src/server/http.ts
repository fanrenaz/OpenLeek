import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { llmConfigurationService } from "./runtime";

const patchSchema = z.object({
  baseRevision: z.string().min(1).max(240),
  changes: z.array(z.object({
    kind: z.enum(["defaults", "model", "provider", "provider_offer", "route"]),
    id: z.string().min(1).max(240),
    field: z.string().min(1).max(240),
    value: z.unknown(),
  }).strict()).max(500),
}).strict();

const createSchema = z.object({
  baseRevision: z.string().min(1).max(240),
  id: z.string().min(1).max(240),
  value: z.record(z.string(), z.unknown()),
}).strict();

export async function requireManagement(request: Request) {
  requireBearer(request, process.env.OPENLEEK_LLM_CONFIGURATION_MANAGEMENT_TOKEN, "LLM configuration management");
}

export async function requireConsumer(request: Request) {
  requireBearer(request, process.env.OPENLEEK_LLM_CONFIGURATION_HINDSIGHT_TOKEN, "hindsight profile");
}

export async function graph() {
  return Response.json(await (await llmConfigurationService()).graph());
}

export async function capability() {
  return Response.json(await (await llmConfigurationService()).capability());
}

export async function validate(request: Request) {
  const body = patchSchema.parse(await request.json());
  return patchResponse(await (await llmConfigurationService()).validate({
    baseRevision: body.baseRevision,
    changes: body.changes.map((change) => ({ ...change, value: change.value })),
  }));
}

export async function patch(request: Request) {
  const body = patchSchema.parse(await request.json());
  return patchResponse(await (await llmConfigurationService()).patch({
    baseRevision: body.baseRevision,
    changes: body.changes.map((change) => ({ ...change, value: change.value })),
  }));
}

export async function create(kind: string, request: Request) {
  const body = createSchema.parse(await request.json());
  return patchResponse(await (await llmConfigurationService()).create(kind, body));
}

export async function remove(kind: string, id: string, request: Request) {
  const url = new URL(request.url);
  const queryRevision = url.searchParams.get("baseRevision");
  let baseRevision = queryRevision;
  if (!baseRevision && request.headers.get("content-length") !== "0") {
    const body = z.object({ baseRevision: z.string().min(1).max(240) }).strict().parse(await request.json());
    baseRevision = body.baseRevision;
  }
  if (!baseRevision) return Response.json({ error: "baseRevision is required" }, { status: 400 });
  return patchResponse(await (await llmConfigurationService()).delete(kind, id, baseRevision));
}

export async function profile(revision: string, route: string) {
  const value = await (await llmConfigurationService()).profile(revision, route);
  return value ? Response.json(value) : Response.json({ error: "revision not found" }, { status: 404 });
}

export async function currentProfile(route?: string) {
  return Response.json(await (await llmConfigurationService()).currentProfile(route));
}

export function failure(error: unknown) {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "invalid_request", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "internal error";
  return Response.json({ error: "internal_error", message }, { status: 500 });
}

function patchResponse(value: { result: string }) {
  const status = value.result === "revisionConflict" ? 409 : value.result === "validationRejected" ? 400 : 200;
  return Response.json(value, { status });
}

function requireBearer(request: Request, expected: string | undefined, label: string) {
  if (!expected) throw new HttpAuthError(`${label} token is not configured`, 503);
  const authorization = request.headers.get("authorization");
  const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new HttpAuthError("invalid_token", 401);
  }
}

export class HttpAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function authFailure(error: unknown) {
  if (error instanceof HttpAuthError) {
    return Response.json({ error: error.status === 401 ? "invalid_token" : "service_unavailable" }, {
      status: error.status,
      ...(error.status === 401 ? { headers: { "www-authenticate": 'Bearer error="invalid_token"' } } : {}),
    });
  }
  return failure(error);
}
