export const runtime = "nodejs";
export function GET() { return Response.json({ status: "ready", service: "context-provisioner" }); }
