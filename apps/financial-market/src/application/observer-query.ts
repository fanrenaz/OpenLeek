import { identifierSchema } from "@openleek/contracts/core";
import { z } from "zod";
import type { FinancialRevisionService } from "./revision-service";

const numericCursorSchema = z.string().regex(/^\d+$/);

export const financialObserverQuerySchema = z.object({
  runId: identifierSchema,
  revisionRef: identifierSchema,
  view: z.enum(["snapshot", "trades", "orders"]).default("snapshot"),
  depth: z.number().int().min(1).max(50).optional(),
  roundId: z.number().int().nonnegative().optional(),
  side: z.enum(["buy", "sell"]).optional(),
  cursor: numericCursorSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

export type FinancialObserverQuery = z.infer<typeof financialObserverQuerySchema>;

export async function queryFinancialObserver(
  service: FinancialRevisionService,
  input: FinancialObserverQuery,
): Promise<unknown> {
  const snapshot = await service.getObserverSnapshot(input.runId, input.revisionRef, input.depth ?? 20);
  if (input.view === "snapshot") {
    const { trades: _trades, orders: _orders, ...result } = snapshot;
    return result;
  }
  if (input.view === "trades") {
    const values = input.roundId === undefined
      ? snapshot.trades
      : snapshot.trades.filter((trade) => trade.roundId === input.roundId);
    return page(values.toReversed(), input.cursor, input.limit ?? 100);
  }
  const values = input.side === undefined
    ? snapshot.orders
    : snapshot.orders.filter((order) => order.side === input.side);
  return page(values, input.cursor, input.limit ?? 100);
}

function page<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}
