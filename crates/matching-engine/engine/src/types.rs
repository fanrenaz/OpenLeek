/// Trade types for the matching engine.

#[derive(Debug, Clone)]
pub struct Trade {
    pub price: f64,
    pub quantity: u32,
    pub buyer_id: String,
    pub seller_id: String,
    pub buyer_order_id: String,
    pub seller_order_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderType {
    Limit,
    Market,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus {
    Pending,
    Partial,
    Filled,
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct Order {
    pub order_id: String,
    pub agent_id: String,
    pub side: Side,
    pub order_type: OrderType,
    pub price: f64,
    pub quantity: u32,
    pub filled_quantity: u32,
    pub timestamp: f64,
    pub status: OrderStatus,
}

/// Entry in the order book, sorted by price-time priority.
#[derive(Debug, Clone)]
pub struct BookEntry {
    /// For bids: negated price (so higher bids sort first in BTreeMap).
    /// For asks: natural price (lower asks sort first).
    pub sort_key: (i64, i64), // (price_bits, timestamp_bits) for deterministic ordering
    pub order_id: String,
    pub agent_id: String,
    pub remaining: u32,
    pub original_price: f64,
}

impl PartialEq for BookEntry {
    fn eq(&self, other: &Self) -> bool {
        self.sort_key == other.sort_key
    }
}

impl Eq for BookEntry {}

impl PartialOrd for BookEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for BookEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key.cmp(&other.sort_key)
    }
}
