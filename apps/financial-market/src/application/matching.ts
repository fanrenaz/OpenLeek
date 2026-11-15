import type { Order, OrderSide } from "../domain/models";

export interface MatchedOrderPair {
  buyOrderId: string;
  sellOrderId: string;
  quantity: number;
  price: number;
}

export interface FinancialMarketMatcher {
  match(openOrders: readonly Order[]): readonly MatchedOrderPair[];
  matchNext(openOrders: readonly Order[]): MatchedOrderPair | undefined;
}

/**
 * Deterministically rebuilds a temporary order book from durable open orders.
 * It deliberately owns no balances, lifecycle, or persisted book object.
 * Price-time order and execution pricing mirror the Rust matching-core API.
 */
export class DeterministicOrderBookMatcher implements FinancialMarketMatcher {
  matchNext(openOrders: readonly Order[]): MatchedOrderPair | undefined {
    return this.match(openOrders)[0];
  }

  match(openOrders: readonly Order[]): readonly MatchedOrderPair[] {
    const bids: WorkOrder[] = [];
    const asks: WorkOrder[] = [];
    const matches: MatchedOrderPair[] = [];

    for (const incoming of [...openOrders].sort((left, right) => left.createdSequence - right.createdSequence)) {
      const work: WorkOrder = { ...incoming };
      const opposite = work.side === "buy" ? asks : bids;
      while (work.remaining > 0) {
        const index = firstExecutable(opposite, work);
        if (index === -1) break;
        const resting = opposite[index]!;
        const quantity = Math.min(work.remaining, resting.remaining);
        matches.push(
          work.side === "buy"
            ? {
                buyOrderId: work.orderId,
                sellOrderId: resting.orderId,
                quantity,
                price: priceOf(resting),
              }
            : {
                buyOrderId: resting.orderId,
                sellOrderId: work.orderId,
                quantity,
                price: priceOf(resting),
              },
        );
        work.remaining -= quantity;
        resting.remaining -= quantity;
        if (resting.remaining === 0) opposite.splice(index, 1);
      }
      if (work.remaining > 0) {
        const ownBook = work.side === "buy" ? bids : asks;
        ownBook.push(work);
        ownBook.sort(compareBook(work.side));
      }
    }
    return matches;
  }
}

interface WorkOrder extends Order {
  remaining: number;
}

function firstExecutable(book: readonly WorkOrder[], incoming: WorkOrder): number {
  for (let index = 0; index < book.length; index += 1) {
    const resting = book[index]!;
    if (!crosses(incoming, resting)) return -1;
    // Native matching core also avoids self-trades. Skipping leaves the order
    // resting and permits a price-compatible third-party order behind it.
    if (resting.accountId !== incoming.accountId) return index;
  }
  return -1;
}

function crosses(incoming: WorkOrder, resting: WorkOrder): boolean {
  return incoming.side === "buy"
    ? priceOf(incoming) >= priceOf(resting)
    : priceOf(incoming) <= priceOf(resting);
}

function compareBook(side: OrderSide): (left: WorkOrder, right: WorkOrder) => number {
  return side === "buy"
    ? (left, right) => priceOf(right) - priceOf(left) || left.createdSequence - right.createdSequence
    : (left, right) => priceOf(left) - priceOf(right) || left.createdSequence - right.createdSequence;
}

function priceOf(order: Order): number {
  if (order.limitPrice === undefined) throw new Error("matcher received an unpriced market order");
  return order.limitPrice;
}
