import { invalid } from "../domain/errors";
import type { Order } from "../domain/models";
import type { FinancialMarketMatcher, MatchedOrderPair } from "../application/matching";

export interface MatchingEngineNapiBinding {
  matchOpenOrders(orders: readonly NapiOrder[]): readonly NapiTrade[];
}

export interface NapiOrder {
  orderId: string;
  accountId: string;
  side: "buy" | "sell";
  remaining: number;
  limitPrice: number;
  createdSequence: number;
}

export interface NapiTrade {
  buyOrderId: string;
  sellOrderId: string;
  quantity: number;
  price: number;
}

/**
 * Thin validation adapter around the internal Rust N-API binding. It receives
 * a fresh, deterministically ordered list each call, so engine objects never
 * become Financial Market persistence.
 */
export class NapiFinancialMarketMatcher implements FinancialMarketMatcher {
  constructor(private readonly binding: MatchingEngineNapiBinding) {}

  matchNext(openOrders: readonly Order[]): MatchedOrderPair | undefined {
    return this.match(openOrders)[0];
  }

  match(openOrders: readonly Order[]): readonly MatchedOrderPair[] {
    const raw = this.binding.matchOpenOrders(
      [...openOrders]
        .sort((left, right) => left.createdSequence - right.createdSequence)
        .map((order) => ({
          orderId: order.orderId,
          accountId: order.accountId,
          side: order.side,
          remaining: order.remaining,
          limitPrice: requiredLimitPrice(order),
          createdSequence: order.createdSequence,
        })),
    );
    return raw.map((trade) => {
      if (
        !trade.buyOrderId ||
        !trade.sellOrderId ||
        !Number.isSafeInteger(trade.quantity) ||
        !Number.isSafeInteger(trade.price)
      ) {
        throw invalid("N-API matcher returned an invalid trade");
      }
      return { ...trade };
    });
  }
}

function requiredLimitPrice(order: Order): number {
  if (order.limitPrice === undefined) throw new Error("matcher received an unpriced market order");
  return order.limitPrice;
}
