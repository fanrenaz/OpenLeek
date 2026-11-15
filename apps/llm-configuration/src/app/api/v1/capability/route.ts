import { authFailure, capability, requireManagement } from "../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await requireManagement(request); return await capability(); } catch (error) { return authFailure(error); }
}
