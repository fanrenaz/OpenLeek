import { authorized } from "../../../../../server/auth";
import { newsDescriptor } from "../../../../../server/router";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return authorized(request) ? Response.json(newsDescriptor) : Response.json({ error: "authorization required" }, { status: 401 });
}
