import { authFailure, remove, requireManagement } from "../../../../../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  try {
    await requireManagement(request);
    const { kind, id } = await context.params;
    return await remove(kind, id, request);
  } catch (error) {
    return authFailure(error);
  }
}
