//! Stateless N-API adapter for the Financial Market context.
//!
//! The TypeScript Context persists orders itself, then passes its complete set
//! of durable open orders here in sequence order. This crate therefore never
//! becomes an external source of state or settlement truth.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use openleek_engine::MatchingEngineInner;

#[napi(object)]
pub struct NapiOrder {
    pub order_id: String,
    pub account_id: String,
    pub side: String,
    pub remaining: u32,
    pub limit_price: f64,
    pub created_sequence: f64,
}

#[napi(object)]
pub struct NapiTrade {
    pub buy_order_id: String,
    pub sell_order_id: String,
    pub quantity: u32,
    pub price: f64,
}

/// Rebuild one ephemeral book and return price-time, self-trade-safe fills.
/// Integer price/sequence values are represented as JS numbers at this narrow
/// FFI boundary and are validated by the TypeScript adapter before settlement.
#[napi]
pub fn match_open_orders(mut orders: Vec<NapiOrder>) -> Result<Vec<NapiTrade>> {
    orders.sort_by(|left, right| {
        left.created_sequence
            .total_cmp(&right.created_sequence)
            .then_with(|| left.order_id.cmp(&right.order_id))
    });

    let mut engine = MatchingEngineInner::new(0.0, None, orders.len().max(1));
    let mut result = Vec::new();
    for order in orders {
        let side = match order.side.as_str() {
            "buy" => 0,
            "sell" => 1,
            _ => return Err(Error::from_reason("side must be buy or sell".to_owned())),
        };
        if !order.limit_price.is_finite() || order.limit_price < 1.0 {
            return Err(Error::from_reason("limit_price must be a positive finite number".to_owned()));
        }
        if !order.created_sequence.is_finite() || order.created_sequence < 0.0 {
            return Err(Error::from_reason("created_sequence must be a non-negative finite number".to_owned()));
        }
        let trades = engine.submit_order(
            &order.order_id,
            &order.account_id,
            side,
            0,
            order.limit_price,
            order.remaining,
            order.created_sequence,
        );
        result.extend(trades.into_iter().map(|trade| NapiTrade {
            buy_order_id: trade.buyer_order_id,
            sell_order_id: trade.seller_order_id,
            quantity: trade.quantity,
            price: trade.price,
        }));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{match_open_orders, NapiOrder};

    fn order(
        order_id: &str,
        account_id: &str,
        side: &str,
        remaining: u32,
        limit_price: f64,
        created_sequence: f64,
    ) -> NapiOrder {
        NapiOrder {
            order_id: order_id.into(),
            account_id: account_id.into(),
            side: side.into(),
            remaining,
            limit_price,
            created_sequence,
        }
    }

    #[test]
    fn matches_in_price_time_order_at_the_resting_order_price() {
        let trades = match_open_orders(vec![
            order("sell-1", "seller-1", "sell", 2, 90.0, 1.0),
            order("sell-2", "seller-2", "sell", 2, 95.0, 2.0),
            order("buy", "buyer", "buy", 3, 100.0, 3.0),
        ])
        .expect("valid orders");

        assert_eq!(trades.len(), 2);
        assert_eq!(trades[0].sell_order_id, "sell-1");
        assert_eq!(trades[0].quantity, 2);
        assert_eq!(trades[0].price, 90.0);
        assert_eq!(trades[1].sell_order_id, "sell-2");
        assert_eq!(trades[1].quantity, 1);
        assert_eq!(trades[1].price, 95.0);
    }

    #[test]
    fn prevents_self_trade_while_matching_a_third_party_order() {
        let trades = match_open_orders(vec![
            order("self-ask", "maker", "sell", 1, 90.0, 1.0),
            order("third-ask", "other", "sell", 1, 95.0, 2.0),
            order("self-buy", "maker", "buy", 1, 100.0, 3.0),
        ])
        .expect("valid orders");

        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].buy_order_id, "self-buy");
        assert_eq!(trades[0].sell_order_id, "third-ask");
    }
}
