import { timingSafeEqual } from "node:crypto";

export const observerHeader = "x-openleek-observer-token";

export function hasObserverAccess(request: Request): boolean {
  const expected = process.env.OPENLEEK_CONTEXT_OBSERVER_PROXY_TOKEN;
  const submitted = request.headers.get(observerHeader);
  if (!expected || !submitted) return false;
  const left = Buffer.from(submitted);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
