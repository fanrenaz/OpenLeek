import "@openleek/observability/bootstrap";

export async function registerNodeInstrumentation(): Promise<void> {
  if (process.env.OPENLEEK_FINANCIAL_MARKET_WORKER !== "true") return;
  const { startFinancialMarketWorker } = await import("./server/worker-runner");
  await startFinancialMarketWorker();
}
