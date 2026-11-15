import { authFailure, currentProfile, requireConsumer } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const consumer = new URL(request.url).searchParams.get("consumer");
    if (consumer !== "hindsight") return Response.json({ error: "invalid consumer" }, { status: 400 });
    await requireConsumer(request);
    const route = new URL(request.url).searchParams.get("route") ?? undefined;
    return await currentProfile(route);
  } catch (error) {
    return authFailure(error);
  }
}
