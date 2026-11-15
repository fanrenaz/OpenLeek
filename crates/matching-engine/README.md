# OpenLeek Matching Engine

High-performance limit order book (LOB) matching engine implemented in Rust with Python bindings via PyO3.

## Overview

This crate provides a drop-in replacement for `openleek.market.engine.MatchingEngine` with ~100x throughput for large order volumes (100K+ orders per simulation round).

**Same semantics, faster execution:**
- Price-time priority continuous double auction
- Self-trade prevention
- Limit and market order types
- Fee accounting (both sides)
- Order TTL expiry

## Installation

```bash
# From the crate directory:
pip install maturin
maturin develop --release

# Or install as a package:
pip install openleek-matching-engine
```

## Usage

The engine is auto-detected by OpenLeek when installed:

```python
from openleek.market.engine import create_engine

# Auto-detect: uses Rust if available, Python fallback
engine = create_engine(backend="auto")

# Explicit:
engine = create_engine(backend="rust")
engine = create_engine(backend="python")
```

## Configuration

Enable in `config/default.yaml`:

```yaml
distributed:
  matching_engine: "rust"  # or "auto" or "python"
```

## Development

```bash
cd openleek-matching-engine
cargo test           # Run Rust unit tests
maturin develop      # Build debug + install in current venv
maturin develop --release  # Optimized build
```

## Benchmarks

On a single core (Apple M2):
- Python MatchingEngine: ~1,000 orders/sec
- Rust MatchingEngine: ~150,000 orders/sec

The Rust engine enables processing 100K orders in <1 second, making continuous LOB matching viable for million-agent simulations.
