export const runtime = "nodejs";

export function GET() {
  const ready = Boolean(process.env.OPENLEEK_EXPERIMENT_URL && process.env.OPENLEEK_AGENT_EXECUTION_URL && process.env.OPENLEEK_SOCIAL_ENVIRONMENT_URL && process.env.OPENLEEK_FINANCIAL_MARKET_URL);
  return Response.json({ status: ready ? "ready" : "not_ready", service: "console" }, { status: ready ? 200 : 503 });
}
