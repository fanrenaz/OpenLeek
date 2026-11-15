import { llmConfigurationService } from "../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const capability = await (await llmConfigurationService()).capability();
    return Response.json({ ok: true, revision: capability.revision });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
