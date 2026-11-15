//! Core LOB matching engine — price-time priority continuous double auction.
//!
//! This crate contains the matching engine logic with no FFI dependencies.
//! It is consumed by the `openleek-matching-engine-napi` binding used by the
//! financial-market Next.js service.

pub mod engine;
pub mod types;

pub use engine::MatchingEngineInner;
pub use types::*;
