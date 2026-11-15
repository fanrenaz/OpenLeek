// Core matching engine — price-time priority continuous double auction.
//
// This implements the same logic as openleek/market/engine.py in Rust
// for ~100x throughput on large order volumes (100K+ orders/round).
//
// Key features:
// - Price-time priority (BTreeSet for O(log n) insert/remove)
// - Self-trade prevention
// - Limit and market order types
// - Fee accounting (both sides)
// - Order TTL expiry (heap-based)

use std::collections::{BTreeSet, BinaryHeap, HashMap, VecDeque};
use std::cmp::Reverse;

use crate::types::{BookEntry, Order, OrderStatus, OrderType, Side, Trade};

pub struct MatchingEngineInner {
    bids: BTreeSet<BookEntry>,
    asks: BTreeSet<BookEntry>,
    orders: HashMap<String, Order>,
    book_entries: HashMap<String, BookEntry>,
    trades: VecDeque<Trade>,
    max_trades: usize,
    last_price: Option<f64>,
    trade_counter: u64,

    // Fee and expiry
    trading_fee_rate: f64,
    total_fees: f64,
    order_ttl_rounds: Option<u32>,
    current_round: u32,
    // Min-heap: (expiry_round, order_id)
    expiry_heap: BinaryHeap<Reverse<(u32, String)>>,
}

impl MatchingEngineInner {
    pub fn new(trading_fee_rate: f64, order_ttl_rounds: Option<u32>, max_trades: usize) -> Self {
        Self {
            bids: BTreeSet::new(),
            asks: BTreeSet::new(),
            orders: HashMap::new(),
            book_entries: HashMap::new(),
            trades: VecDeque::with_capacity(max_trades),
            max_trades,
            last_price: None,
            trade_counter: 0,
            trading_fee_rate,
            total_fees: 0.0,
            order_ttl_rounds,
            current_round: 0,
            expiry_heap: BinaryHeap::new(),
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn submit_order(
        &mut self,
        order_id: &str,
        agent_id: &str,
        side: u8,
        order_type: u8,
        price: f64,
        quantity: u32,
        timestamp: f64,
    ) -> Vec<Trade> {
        // Input validation
        if quantity == 0 {
            return Vec::new();
        }
        if price.is_nan() || price.is_infinite() || price < 0.0 {
            return Vec::new();
        }
        if timestamp.is_nan() || timestamp.is_infinite() {
            return Vec::new();
        }

        let side_enum = if side == 0 { Side::Buy } else { Side::Sell };
        let type_enum = if order_type == 0 { OrderType::Limit } else { OrderType::Market };

        let order = Order {
            order_id: order_id.to_string(),
            agent_id: agent_id.to_string(),
            side: side_enum,
            order_type: type_enum,
            price,
            quantity,
            filled_quantity: 0,
            timestamp,
            status: OrderStatus::Pending,
        };

        self.orders.insert(order_id.to_string(), order.clone());

        // TTL tracking
        if let Some(ttl) = self.order_ttl_rounds {
            let expiry = self.current_round + ttl;
            self.expiry_heap.push(Reverse((expiry, order_id.to_string())));
        }

        let trades = match type_enum {
            OrderType::Market => self.match_market(order_id, agent_id, side_enum, quantity),
            OrderType::Limit => self.match_limit(order_id, agent_id, side_enum, price, quantity, timestamp),
        };

        // Update order status
        if let Some(ord) = self.orders.get_mut(order_id) {
            if ord.filled_quantity >= ord.quantity {
                ord.status = OrderStatus::Filled;
            } else if ord.filled_quantity > 0 {
                ord.status = OrderStatus::Partial;
            }
        }

        trades
    }

    #[inline]
    fn match_limit(
        &mut self,
        order_id: &str,
        agent_id: &str,
        side: Side,
        price: f64,
        quantity: u32,
        timestamp: f64,
    ) -> Vec<Trade> {
        let mut trades = Vec::new();
        let mut remaining = quantity;

        match side {
            Side::Buy => {
                // Match against asks where ask_price <= order price
                while remaining > 0 {
                    // Find best non-self ask within price limit
                    let best = {
                        let mut found = None;
                        for entry in self.asks.iter() {
                            if entry.original_price > price {
                                break; // No more eligible price levels
                            }
                            if entry.agent_id != agent_id {
                                found = Some(entry.clone());
                                break;
                            }
                        }
                        match found {
                            Some(e) => e,
                            None => break,
                        }
                    };
                    let fill_qty = remaining.min(best.remaining);
                    let trade = self.create_trade(
                        best.original_price,
                        fill_qty,
                        agent_id.to_string(),
                        best.agent_id.clone(),
                        order_id.to_string(),
                        best.order_id.clone(),
                    );
                    trades.push(trade);
                    remaining -= fill_qty;

                    // Update this order's filled quantity
                    if let Some(ord) = self.orders.get_mut(order_id) {
                        ord.filled_quantity += fill_qty;
                    }

                    // Update resting order
                    let mut updated_entry = best.clone();
                    updated_entry.remaining -= fill_qty;

                    self.asks.remove(&best);
                    if updated_entry.remaining > 0 {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Partial;
                        }
                        self.book_entries.insert(best.order_id.clone(), updated_entry.clone());
                        self.asks.insert(updated_entry);
                    } else {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Filled;
                        }
                        self.book_entries.remove(&best.order_id);
                    }
                }
            }
            Side::Sell => {
                // Match against bids where bid_price >= order price
                // Bids are sorted with negated price, so first entry = highest bid
                while remaining > 0 {
                    // Find best non-self bid within price limit
                    let best = {
                        let mut found = None;
                        for entry in self.bids.iter() {
                            if entry.original_price < price {
                                break; // No more eligible price levels
                            }
                            if entry.agent_id != agent_id {
                                found = Some(entry.clone());
                                break;
                            }
                        }
                        match found {
                            Some(e) => e,
                            None => break,
                        }
                    };
                    let fill_qty = remaining.min(best.remaining);
                    let trade = self.create_trade(
                        best.original_price,
                        fill_qty,
                        best.agent_id.clone(),
                        agent_id.to_string(),
                        best.order_id.clone(),
                        order_id.to_string(),
                    );
                    trades.push(trade);
                    remaining -= fill_qty;

                    if let Some(ord) = self.orders.get_mut(order_id) {
                        ord.filled_quantity += fill_qty;
                    }

                    let mut updated_entry = best.clone();
                    updated_entry.remaining -= fill_qty;

                    self.bids.remove(&best);
                    if updated_entry.remaining > 0 {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Partial;
                        }
                        self.book_entries.insert(best.order_id.clone(), updated_entry.clone());
                        self.bids.insert(updated_entry);
                    } else {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Filled;
                        }
                        self.book_entries.remove(&best.order_id);
                    }
                }
            }
        }

        // Rest unfilled portion
        if remaining > 0 {
            self.add_to_book(order_id, agent_id, side, price, remaining, timestamp);
        }

        trades
    }

    #[inline]
    fn match_market(
        &mut self,
        order_id: &str,
        agent_id: &str,
        side: Side,
        quantity: u32,
    ) -> Vec<Trade> {
        let mut trades = Vec::new();
        let mut remaining = quantity;

        match side {
            Side::Buy => {
                while remaining > 0 {
                    // Find best non-self ask
                    let best = {
                        let mut found = None;
                        for entry in self.asks.iter() {
                            if entry.agent_id != agent_id {
                                found = Some(entry.clone());
                                break;
                            }
                        }
                        match found {
                            Some(e) => e,
                            None => break,
                        }
                    };
                    let fill_qty = remaining.min(best.remaining);
                    let trade = self.create_trade(
                        best.original_price,
                        fill_qty,
                        agent_id.to_string(),
                        best.agent_id.clone(),
                        order_id.to_string(),
                        best.order_id.clone(),
                    );
                    trades.push(trade);
                    remaining -= fill_qty;

                    if let Some(ord) = self.orders.get_mut(order_id) {
                        ord.filled_quantity += fill_qty;
                    }

                    let mut updated_entry = best.clone();
                    updated_entry.remaining -= fill_qty;

                    self.asks.remove(&best);
                    if updated_entry.remaining > 0 {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Partial;
                        }
                        self.book_entries.insert(best.order_id.clone(), updated_entry.clone());
                        self.asks.insert(updated_entry);
                    } else {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Filled;
                        }
                        self.book_entries.remove(&best.order_id);
                    }
                }
            }
            Side::Sell => {
                while remaining > 0 {
                    // Find best non-self bid
                    let best = {
                        let mut found = None;
                        for entry in self.bids.iter() {
                            if entry.agent_id != agent_id {
                                found = Some(entry.clone());
                                break;
                            }
                        }
                        match found {
                            Some(e) => e,
                            None => break,
                        }
                    };
                    let fill_qty = remaining.min(best.remaining);
                    let trade = self.create_trade(
                        best.original_price,
                        fill_qty,
                        best.agent_id.clone(),
                        agent_id.to_string(),
                        best.order_id.clone(),
                        order_id.to_string(),
                    );
                    trades.push(trade);
                    remaining -= fill_qty;

                    if let Some(ord) = self.orders.get_mut(order_id) {
                        ord.filled_quantity += fill_qty;
                    }

                    let mut updated_entry = best.clone();
                    updated_entry.remaining -= fill_qty;

                    self.bids.remove(&best);
                    if updated_entry.remaining > 0 {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Partial;
                        }
                        self.book_entries.insert(best.order_id.clone(), updated_entry.clone());
                        self.bids.insert(updated_entry);
                    } else {
                        if let Some(resting) = self.orders.get_mut(&best.order_id) {
                            resting.filled_quantity += fill_qty;
                            resting.status = OrderStatus::Filled;
                        }
                        self.book_entries.remove(&best.order_id);
                    }
                }
            }
        }

        // Market orders don't rest
        trades
    }

    #[inline]
    fn add_to_book(
        &mut self,
        order_id: &str,
        agent_id: &str,
        side: Side,
        price: f64,
        remaining: u32,
        timestamp: f64,
    ) {
        // Convert price to integer bits for deterministic ordering
        let price_bits = (price * 1_000_000.0) as i64;
        let ts_bits = (timestamp * 1_000_000.0) as i64;

        let sort_key = match side {
            Side::Buy => (-price_bits, ts_bits),  // Higher price first (negated)
            Side::Sell => (price_bits, ts_bits),   // Lower price first
        };

        let entry = BookEntry {
            sort_key,
            order_id: order_id.to_string(),
            agent_id: agent_id.to_string(),
            remaining,
            original_price: price,
        };

        self.book_entries.insert(order_id.to_string(), entry.clone());
        match side {
            Side::Buy => { self.bids.insert(entry); }
            Side::Sell => { self.asks.insert(entry); }
        }

        // Invariant: book_entries and BTreeSets must stay in sync
        debug_assert_eq!(
            self.book_entries.len(),
            self.bids.len() + self.asks.len(),
            "book_entries count mismatch with bids+asks"
        );
    }

    /// Clear trade history to free memory in long-running simulations.
    pub fn clear_trades(&mut self) {
        self.trades.clear();
    }

    /// Number of trades stored in history.
    pub fn trades_len(&self) -> usize {
        self.trades.len()
    }

    #[inline]
    fn create_trade(
        &mut self,
        price: f64,
        quantity: u32,
        buyer_id: String,
        seller_id: String,
        buyer_order_id: String,
        seller_order_id: String,
    ) -> Trade {
        self.trade_counter += 1;
        self.last_price = Some(price);

        // Fee accounting
        let trade_value = price * (quantity as f64);
        self.total_fees += trade_value * self.trading_fee_rate * 2.0;

        let trade = Trade {
            price,
            quantity,
            buyer_id,
            seller_id,
            buyer_order_id,
            seller_order_id,
        };

        if self.trades.len() >= self.max_trades {
            self.trades.pop_front();
        }
        self.trades.push_back(trade.clone());

        trade
    }

    pub fn cancel_order(&mut self, order_id: &str) -> bool {
        if let Some(entry) = self.book_entries.remove(order_id) {
            if let Some(ord) = self.orders.get(order_id) {
                match ord.side {
                    Side::Buy => { self.bids.remove(&entry); }
                    Side::Sell => { self.asks.remove(&entry); }
                }
            }
            if let Some(ord) = self.orders.get_mut(order_id) {
                ord.status = OrderStatus::Cancelled;
            }
            true
        } else {
            false
        }
    }

    pub fn get_best_bid(&self) -> Option<f64> {
        self.bids.iter().next().map(|e| e.original_price)
    }

    pub fn get_best_ask(&self) -> Option<f64> {
        self.asks.iter().next().map(|e| e.original_price)
    }

    #[allow(clippy::type_complexity)]
    pub fn get_depth(&self, levels: usize) -> (Vec<(f64, u32)>, Vec<(f64, u32)>) {
        let bids = self.aggregate_side_iter(self.bids.iter(), levels);
        let asks = self.aggregate_side_iter(self.asks.iter(), levels);
        (bids, asks)
    }

    fn aggregate_side_iter<'a>(
        &self,
        iter: impl Iterator<Item = &'a BookEntry>,
        levels: usize,
    ) -> Vec<(f64, u32)> {
        let mut result = Vec::with_capacity(levels);
        let mut current_price: Option<f64> = None;
        let mut current_qty: u32 = 0;

        for entry in iter {
            if result.len() >= levels {
                break;
            }
            match current_price {
                None => {
                    current_price = Some(entry.original_price);
                    current_qty = entry.remaining;
                }
                // Compare using integer-quantized price for deterministic grouping
                Some(cp) if ((cp * 1_000_000.0) as i64) == ((entry.original_price * 1_000_000.0) as i64) => {
                    current_qty += entry.remaining;
                }
                Some(cp) => {
                    result.push((cp, current_qty));
                    current_price = Some(entry.original_price);
                    current_qty = entry.remaining;
                }
            }
        }
        if let Some(cp) = current_price {
            if result.len() < levels {
                result.push((cp, current_qty));
            }
        }
        result
    }

    pub fn advance_round(&mut self) -> Vec<String> {
        self.current_round += 1;
        let mut expired = Vec::new();

        if self.order_ttl_rounds.is_none() {
            return expired;
        }

        while let Some(Reverse((expiry, ref order_id))) = self.expiry_heap.peek() {
            if *expiry > self.current_round {
                break;
            }
            let order_id = order_id.clone();
            self.expiry_heap.pop();
            if self.book_entries.contains_key(&order_id) {
                self.cancel_order(&order_id);
                expired.push(order_id);
            }
        }

        expired
    }

    pub fn get_order_status(&self, order_id: &str) -> &str {
        match self.orders.get(order_id) {
            Some(ord) => match ord.status {
                OrderStatus::Filled => "filled",
                OrderStatus::Partial => "partial",
                OrderStatus::Pending => "pending",
                OrderStatus::Cancelled => "cancelled",
            },
            None => "unknown",
        }
    }

    pub fn get_filled_quantity(&self, order_id: &str) -> u32 {
        self.orders
            .get(order_id)
            .map(|o| o.filled_quantity)
            .unwrap_or(0)
    }

    pub fn bid_volume(&self) -> u32 {
        self.bids.iter().map(|e| e.remaining).sum()
    }

    pub fn ask_volume(&self) -> u32 {
        self.asks.iter().map(|e| e.remaining).sum()
    }

    pub fn fee_rate(&self) -> f64 {
        self.trading_fee_rate
    }

    pub fn total_fees(&self) -> f64 {
        self.total_fees
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_limit_match() {
        let mut engine = MatchingEngineInner::new(0.001, None, 1000);

        // Submit a sell limit at 100.0
        let trades = engine.submit_order("S1", "seller1", 1, 0, 100.0, 10, 1.0);
        assert!(trades.is_empty()); // No match, rests in book

        // Submit a buy limit at 100.0 — should match
        let trades = engine.submit_order("B1", "buyer1", 0, 0, 100.0, 5, 2.0);
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].price, 100.0);
        assert_eq!(trades[0].quantity, 5);
        assert_eq!(trades[0].buyer_id, "buyer1");
        assert_eq!(trades[0].seller_id, "seller1");
    }

    #[test]
    fn test_self_trade_prevention() {
        let mut engine = MatchingEngineInner::new(0.0, None, 1000);

        engine.submit_order("S1", "agent1", 1, 0, 100.0, 10, 1.0);
        // Same agent tries to buy — should NOT match (self-trade prevention)
        let trades = engine.submit_order("B1", "agent1", 0, 0, 100.0, 5, 2.0);
        assert!(trades.is_empty());
    }

    #[test]
    fn test_price_time_priority() {
        let mut engine = MatchingEngineInner::new(0.0, None, 1000);

        // Two sells at different prices
        engine.submit_order("S1", "seller1", 1, 0, 101.0, 10, 1.0);
        engine.submit_order("S2", "seller2", 1, 0, 100.0, 10, 2.0);

        // Buy should match against lower price first
        let trades = engine.submit_order("B1", "buyer1", 0, 0, 101.0, 5, 3.0);
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].price, 100.0); // Matched at seller2's price
        assert_eq!(trades[0].seller_id, "seller2");
    }

    #[test]
    fn test_order_ttl_expiry() {
        let mut engine = MatchingEngineInner::new(0.0, Some(2), 1000);

        engine.submit_order("S1", "seller1", 1, 0, 100.0, 10, 1.0);
        assert_eq!(engine.ask_volume(), 10);

        engine.advance_round(); // round 1
        assert_eq!(engine.ask_volume(), 10); // Still alive

        let expired = engine.advance_round(); // round 2 — TTL expires
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0], "S1");
        assert_eq!(engine.ask_volume(), 0);
    }

    #[test]
    fn test_fee_accounting() {
        let mut engine = MatchingEngineInner::new(0.001, None, 1000); // 0.1% fee

        engine.submit_order("S1", "seller1", 1, 0, 100.0, 10, 1.0);
        engine.submit_order("B1", "buyer1", 0, 0, 100.0, 10, 2.0);

        // Trade value = 100 * 10 = 1000. Fee = 1000 * 0.001 * 2 = 2.0
        assert!((engine.total_fees() - 2.0).abs() < 1e-10);
    }
}
