import { authFailure, create, requireManagement } from "../../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    await requireManagement(request);
    const { kind } = await context.params;
    return await create(kind, request);
  } catch (error) {
    return authFailure(error);
  }
}
