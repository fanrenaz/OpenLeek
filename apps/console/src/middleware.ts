import { NextRequest, NextResponse } from "next/server";
import { consoleAccessConfiguration, consoleAccessCookie, hasValidConsoleAccessSession } from "./server/access";

function isPublicPath(pathname: string) {
  return pathname === "/login"
    || pathname.startsWith("/api/access/")
    || pathname === "/api/control/mcp"
    || pathname === "/health"
    || pathname === "/ready"
    || pathname.startsWith("/_next/");
}

export async function middleware(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next();

  const { sessionSecret, password } = consoleAccessConfiguration();
  const allowed = await hasValidConsoleAccessSession(request.cookies.get(consoleAccessCookie)?.value, sessionSecret, password);
  if (allowed) {
    const context = request.nextUrl.pathname.startsWith("/contexts/financial/")
      ? "financial"
      : request.nextUrl.pathname.startsWith("/contexts/social/")
        ? "social"
        : undefined;
    if (context !== undefined) {
      const token = process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN;
      if (!token) return NextResponse.json({ error: "Context observer proxy is unavailable" }, { status: 503 });
      const headers = new Headers(request.headers);
      headers.set("x-openleek-observer-token", token);
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Console access required" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: "/:path*" };
