import { createHash, randomBytes } from "node:crypto";
import { identifierSchema } from "@openleek/contracts/core";
import { z } from "zod";

const routeSchema = z.object({
  contextId: identifierSchema,
  installationRef: identifierSchema.optional(),
  endpoint: z.string().url().optional(),
  upstreamCredential: z.string().min(1).optional(),
  tools: z.array(identifierSchema),
  resources: z.array(identifierSchema),
}).strict().superRefine((value, context) => {
  if (!value.installationRef && !(value.endpoint && value.upstreamCredential)) context.addIssue({ code: z.ZodIssueCode.custom, message: "route requires installationRef or a legacy endpoint credential" });
});
export const bindingInputSchema = z.object({ runId: identifierSchema, agentId: identifierSchema, routes: z.array(routeSchema).max(100), expiresAt: z.string().datetime() }).strict();
export type BindingInput = z.infer<typeof bindingInputSchema>;
export interface StoredBinding extends BindingInput { tokenDigest: string; revoked: boolean }
export interface GatewayStore { find(tokenDigest: string): Promise<StoredBinding | undefined>; save(value: StoredBinding): Promise<void>; revokeRun(runId: string): Promise<void> }
export interface ResolvedInstallation { installation: { endpoint: string; contextId: string }; bearerToken: string }

export class ContextGateway {
  constructor(private readonly store: GatewayStore, private readonly resolveInstallation: (ref: string) => Promise<ResolvedInstallation>, private readonly fetcher: typeof fetch = fetch) {}
  async issue(input: unknown) {
    const parsed = bindingInputSchema.parse(input);
    const token = randomBytes(32).toString("base64url");
    await this.store.save({ ...parsed, tokenDigest: digest(token), revoked: false });
    return { endpoint: process.env.OPENLEEK_CONTEXT_GATEWAY_PUBLIC_URL ?? "http://context-gateway:3000/mcp", bearerToken: token };
  }
  async revokeRun(runId: string) { await this.store.revokeRun(identifierSchema.parse(runId)); }
  async forward(token: string, body: unknown): Promise<Response> {
    const binding = await this.store.find(digest(token));
    if (!binding || binding.revoked || Date.parse(binding.expiresAt) <= Date.now()) return rpcError(null, -32001, "invalid or expired Context Gateway credential", 401);
    const request = mcpRequestSchema.safeParse(body);
    if (!request.success) return rpcError(null, -32600, "invalid MCP request", 400);
    const target = targetFor(request.data, binding.routes);
    if (!target) return rpcError(request.data.id ?? null, -32601, "capability is not granted", 403);
    const resolved = target.installationRef
      ? await this.resolveInstallation(target.installationRef)
      : { installation: { endpoint: target.endpoint!, contextId: target.contextId }, bearerToken: target.upstreamCredential! };
    if (resolved.installation.contextId !== target.contextId) return rpcError(request.data.id ?? null, -32603, "installation identity mismatch", 502);
    const upstreamCredential = target.upstreamCredential ?? resolved.bearerToken;
    const response = await this.fetcher(new URL("/internal/mcp", resolved.installation.endpoint), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${upstreamCredential}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  }
}

const mcpRequestSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.object({ name: z.string().optional(), uri: z.string().optional() }).passthrough().optional() }).passthrough();
function targetFor(request: z.infer<typeof mcpRequestSchema>, routes: BindingInput["routes"]) {
  const capability = request.method === "tools/call" ? request.params?.name : request.method === "resources/read" ? request.params?.uri : undefined;
  // Experiment currently gives every configured MCP client its own scoped
  // Gateway credential. Protocol negotiation and discovery therefore belong
  // to that credential's sole route; they are not business capabilities and
  // must be forwarded so the upstream MCP server can complete its handshake.
  if (!capability) return routes.length === 1 ? routes[0] : undefined;
  return routes.find((route) => (
    request.method === "tools/call"
      // Codex namespaces an MCP server at the client boundary, but sends the
      // server-local tool name on the wire. Policies remain globally qualified
      // (`financial.get_quote`) so different Contexts cannot collide.
      ? route.tools.some((tool) => tool === capability || tool === `${route.contextId}.${capability}`)
      // Standard MCP resource URIs are routed by their URI scheme. The
      // upstream Context remains the owner of exact revision/resource
      // authorization, while a route with no resource grant stays denied.
      : capability.startsWith(`${route.contextId}://`)
        ? route.resources.length > 0
        : route.resources.some((resource) => capability === resource || capability.startsWith(`${resource}:`) || capability.startsWith(`${resource}/`))
  ));
}
function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }
function rpcError(id: string | number | null, code: number, message: string, status: number) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store" } }); }
