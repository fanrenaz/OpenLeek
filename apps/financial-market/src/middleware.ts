import { NextRequest, NextResponse } from "next/server";

function protectedObserverPath(pathname: string) {
  return pathname.startsWith("/observer/") || pathname === "/observer-api";
}

async function tokenMatches(submitted: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [submittedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(submitted)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(submittedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function middleware(request: NextRequest) {
  if (!protectedObserverPath(request.nextUrl.pathname)) return NextResponse.next();
  const expected = process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN;
  const submitted = request.headers.get("x-openleek-observer-token");
  if (expected && submitted && await tokenMatches(submitted, expected)) return NextResponse.next();
  return NextResponse.json({ error: "observer access required" }, { status: 401 });
}

export const config = { matcher: ["/observer/:path*", "/observer-api"] };
