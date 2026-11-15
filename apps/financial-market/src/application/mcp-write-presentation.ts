import { FinancialMarketError } from "../domain/errors";

const FINANCIAL_WRITE_TOOLS = new Set([
  "place_order",
  "place_limit_order",
  "place_market_order",
  "replace_order",
  "cancel_order",
]);

export function financialRequestIdentity(value: string | number | undefined): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length > 500) {
    throw new Error("Financial write request is missing its transport identity");
  }
  return `${typeof value}:${String(value)}`;
}

export function financialAcknowledgement(name: string): string {
  if (name === "replace_order") return "Order replacement submitted successfully.";
  if (name === "cancel_order") return "Order cancellation submitted successfully.";
  return "Order submitted successfully.";
}

export function publicFinancialMcpError(name: string | undefined, error: unknown): string {
  if (!isFinancialWriteTool(name)) return error instanceof Error ? error.message : String(error);
  if (error instanceof FinancialMarketError) {
    if (error.code === "INVALID_ARGUMENT") return error.message;
    if (error.code === "NOT_FOUND") return "The requested order is unavailable.";
    if (error.code === "PRECONDITION_FAILED" && error.message.includes("action limit reached")) {
      return "Order action limit reached for this round.";
    }
  }
  return "Order action could not be submitted.";
}

export function isFinancialWriteTool(name: string | undefined): boolean {
  return name !== undefined && FINANCIAL_WRITE_TOOLS.has(name);
}
