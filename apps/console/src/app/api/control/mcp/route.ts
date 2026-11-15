import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { passwordMatches } from "../../../../server/access";
import { createControlMcpServer } from "../../../../server/control-mcp";
import { networkConsolePorts } from "../../../../server/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!await authorized(request)) return invalidToken();

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createControlMcpServer(networkConsolePorts());
  await server.connect(transport);
  return transport.handleRequest(request, {
    authInfo: {
      token: "validated-console-access",
      clientId: "openleek-external-control",
      scopes: ["tools:read", "tools:write", "tools:delete", "runs:control"],
    },
  });
}

export async function GET() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function DELETE() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

async function authorized(request: Request) {
  const password = process.env.OPENLEEK_CONSOLE_ACCESS_PASSWORD;
  const configuredOrigin = process.env.OPENLEEK_CONSOLE_PUBLIC_ORIGIN;
  if (!password || !configuredOrigin) return false;

  let publicOrigin: URL;
  try {
    publicOrigin = new URL(configuredOrigin);
  } catch {
    return false;
  }
  if (request.headers.get("host") !== publicOrigin.host) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin.origin) return false;

  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const submitted = authorization.slice(prefix.length);
  return submitted.length > 0 && await passwordMatches(submitted, password);
}

function invalidToken() {
  return Response.json({ error: "invalid_token" }, {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
  });
}
