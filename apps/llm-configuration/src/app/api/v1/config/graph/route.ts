import { authFailure, graph, patch, requireManagement } from "../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await requireManagement(request); return await graph(); } catch (error) { return authFailure(error); }
}

export async function PATCH(request: Request) {
  try { await requireManagement(request); return await patch(request); } catch (error) { return authFailure(error); }
}
