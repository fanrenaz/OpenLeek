import { financialMarketService } from "../../server/runtime";
import { requireFinancialMarketWorkerReady, startFinancialMarketWorker } from "../../server/worker-runner";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (process.env.OPENLEEK_FINANCIAL_MARKET_WORKER === "true") await startFinancialMarketWorker();
    await financialMarketService();
    await requireFinancialMarketWorkerReady();
    return Response.json({ status: "ready", service: "financial-market" });
  } catch (error) {
    return Response.json(
      { status: "not_ready", message: error instanceof Error ? error.message : "initialization failed" },
      { status: 503 },
    );
  }
}
