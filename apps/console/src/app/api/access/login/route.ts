import { NextRequest, NextResponse } from "next/server";
import { consoleAccessConfiguration, consoleAccessCookie, consoleAccessSessionLifetimeSeconds, createConsoleAccessSession, passwordMatches } from "../../../../server/access";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => undefined) as { password?: unknown } | undefined;
  const { password, sessionSecret } = consoleAccessConfiguration();
  if (!password || !sessionSecret) return NextResponse.json({ error: "Console access gate is not configured" }, { status: 503 });
  if (typeof body?.password !== "string" || !await passwordMatches(body.password, password)) return NextResponse.json({ error: "Incorrect password" }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: consoleAccessCookie,
    value: await createConsoleAccessSession(sessionSecret, password),
    httpOnly: true,
    sameSite: "lax",
    secure: request.headers.get("x-forwarded-proto") === "https",
    maxAge: consoleAccessSessionLifetimeSeconds,
    path: "/",
  });
  return response;
}
