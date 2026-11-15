import { SocialMcpService } from "../../../application/social-mcp-service";
import { isSocialWriteTool, publicSocialMcpError, socialAcknowledgement, socialRequestIdentity } from "../../../application/mcp-write-presentation";
import { socialEnvironmentService } from "../../../server/runtime";
import { verifySocialMcpBearer } from "../../../server/social-mcp-bearer";
import { socialMcpToolDefinitions } from "./tool-definitions";

export const runtime = "nodejs";

const tools = socialMcpToolDefinitions;

interface McpRequest {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; uri?: string };
}

/**
 * Context-owned Streamable HTTP-compatible JSON-RPC surface.  It deliberately
 * offers Resources for reads and tools only for durable Social intents.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as McpRequest | null;
  if (!body?.method) return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "invalid request" } }, { status: 400 });
  const id = body.id ?? null;
  try {
    const bearer = request.headers.get("authorization");
    const token = bearerToken(bearer);
    const principal = verifySocialMcpBearer(token);
    if (body.method === "initialize") {
      return json(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "openleek-social-environment", version: "2.0.0" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const mcp = new SocialMcpService(await socialEnvironmentService());
    if (body.method === "tools/list") {
      const allowed = new Set(mcp.listTools(principal));
      return json(id, {
        tools: tools.filter(([name]) => allowed.has(name)).map(([name, description, properties, required]) => ({
          name,
          description,
          inputSchema: {
            type: "object",
            properties,
            ...(required.length === 0 ? {} : { required }),
            additionalProperties: false,
          },
        })),
      });
    }
    if (body.method === "resources/list") return json(id, mcp.listResources(principal));
    if (body.method === "resources/read") {
      const uri = body.params?.uri;
      if (!uri) return json(id, undefined, { code: -32602, message: "missing resource URI" });
      return json(id, mcp.readResource(principal, uri));
    }
    if (body.method === "tools/call") {
      const name = body.params?.name;
      if (!name || !tools.some(([tool]) => tool === name)) return json(id, undefined, { code: -32602, message: "unknown Social tool" });
      const args = body.params?.arguments ?? {};
      if (isSocialWriteTool(name)) {
        await mcp.invoke(principal, name, args, socialRequestIdentity(body.id));
        return json(id, { content: [{ type: "text", text: socialAcknowledgement(name, args) }] });
      }
      const result = await mcp.invoke(principal, name, args);
      return json(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    return json(id, undefined, { code: -32601, message: "method not found" });
  } catch (error) {
    return json(id, undefined, { code: -32000, message: publicSocialMcpError(body.params?.name, error) });
  }
}

function bearerToken(value: string | null): string {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  if (!match?.[1]) throw new Error("missing or invalid Authorization bearer");
  return match[1];
}

/** Social trusts Experiment's configured public key; private signing material never enters this Context. */

function json(id: string | number | null, result?: unknown, error?: { code: number; message: string }) {
  return Response.json(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
}
