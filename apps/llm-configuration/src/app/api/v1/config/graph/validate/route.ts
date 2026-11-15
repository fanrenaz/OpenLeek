import { authFailure, requireManagement, validate } from "../../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try { await requireManagement(request); return await validate(request); } catch (error) { return authFailure(error); }
}
