"""Contract tests for the isolated FeedAlgorithm and MarketMaker runner."""

from __future__ import annotations

import collections
import unittest
from http import HTTPStatus
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from runner import execute_child


LIMITS = {"maxRuntimeMs": 1_000, "maxMemoryMb": 64}
INVENTORY_LADDER_SOURCE = (
    Path(__file__).parent.parent
    / "assets"
    / "market-makers"
    / "inventory-ladder-market-maker.py"
).read_text()
SOURCE = """
class FeedAlgorithm:
    CONFIG_SCHEMA = {"type": "object"}
    DEFAULT_CONFIG = {}
    created = 0

    def __init__(self, config, context):
        FeedAlgorithm.created += 1
        self.config = config
        self.context = context

    def rank(self, actor_id):
        if FeedAlgorithm.created != 1:
            return []
        history = self.context["socialHistory"]
        record_count = 0
        for record in history.all():
            record_count += 1
        selected = history.round(self.config["roundByActor"][actor_id])
        if "capability" in self.context or "endpoint" in self.context:
            return []
        return selected["postIds"][:self.context["feedSize"]] if record_count == 2 else []
"""


def feed_payload(source: str = SOURCE) -> dict[str, object]:
    return {
        "mode": "execute",
        "source": source,
        "dependencies": [],
        "limits": LIMITS,
        "config": {"roundByActor": {"alice": 11, "bob": 12}},
        "seed": "seed",
        "roundId": 7,
        "feedSize": 2,
        "actorIds": ["alice", "bob"],
        "socialHistory": {
            "endpoint": "http://social-environment:3000/internal/feed-algorithm/history",
            "capability": "opaque-social-history-capability",
        },
    }

MARKET_MAKER_SOURCE = """
class MarketMaker:
    CONFIG_SCHEMA = {"type": "object"}
    DEFAULT_CONFIG = {"size": 2}

    def __init__(self, config, context):
        self.config = config
        self.context = context

    def quote(self):
        history = self.context["financialHistory"]
        rounds = list(history.all())
        selected_round = history.round(3)
        account = history.makerAccount()
        baseline = history.participantBaseline()
        if "capability" in self.context or "endpoint" in self.context:
            return []
        return [{
            "side": "buy",
            "limitPrice": selected_round["summary"]["lastTradePrice"],
            "quantity": len(rounds) + account["position"] + baseline["accountCount"] + self.config["size"],
        }]
"""


def market_maker_payload(source: str = MARKET_MAKER_SOURCE) -> dict[str, object]:
    return {
        "algorithmKind": "market_maker",
        "mode": "execute",
        "source": source,
        "dependencies": [],
        "limits": LIMITS,
        "config": {"size": 2},
        "seed": "market-seed",
        "roundId": 4,
        "timing": "settlement",
        "financialHistory": {
            "endpoint": "http://financial-market:3000/internal/market-maker-history",
            "capability": "opaque-history-capability",
        },
    }


def inventory_ladder_payload(config: dict[str, object] | None = None) -> dict[str, object]:
    return {
        **market_maker_payload(INVENTORY_LADDER_SOURCE),
        "config": {
            "quoteSize": {"mode": "fixed"},
            "baseOrderSize": 20,
            "inventoryTarget": {"mode": "fixed", "quantity": 100},
            "inventoryCapacity": {"mode": "fixed", "quantity": 1_000},
            "quoteLevels": 1,
            "ladderDistance": {
                "minBps": 0,
                "maxBps": 0,
                "curve": 1.6,
                "pressureNearWidenBps": 0,
                "pressureFarWidenBps": 0,
                "pressureCurve": 1.3,
            },
            **(config or {}),
        },
        "roundId": 2,
        "timing": "opening",
    }


def inventory_history(
    trades: list[dict[str, object]],
    *,
    opening_reference: int = 100,
    closes: list[int] | None = None,
):
    prices = closes or [100, 100, 100]
    records = [
        {
            "roundId": index,
            "referencePrice": 100,
            "openingReferencePrice": opening_reference if index == 2 else prices[max(0, index - 1)],
            "summary": {"lastTradePrice": price},
            "trades": trades if index == 2 else [],
            "bidDepth": [],
            "askDepth": [],
        }
        for index, price in enumerate(prices)
    ]

    def client(_history: dict[str, str], request: dict[str, object]) -> dict[str, object]:
        if request == {"operation": "all"}:
            return {"records": records}
        if request == {"operation": "makerAccount"}:
            return {
                "account": {
                    "accountId": "maker",
                    "cash": 100_000,
                    "position": 100,
                    "reservedCash": 0,
                    "reservedPosition": 0,
                    "replacementAvailableCash": 100_000,
                    "replacementAvailablePosition": 100,
                }
            }
        if request == {"operation": "participantBaseline"}:
            return {
                "baseline": {
                    "accountCount": 3,
                    "totalCash": 300_000,
                    "totalPosition": 300,
                }
            }
        raise AssertionError(f"unexpected request: {request}")

    return client


class FeedAlgorithmRunnerTests(unittest.TestCase):
    def test_creates_one_instance_and_reads_full_history_through_the_proxy_per_parallel_rank(self) -> None:
        calls: list[dict[str, object]] = []

        def history_client(history: dict[str, str], request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(history, {
                "endpoint": "http://social-environment:3000/internal/feed-algorithm/history",
                "capability": "opaque-social-history-capability",
            })
            calls.append(request)
            if request == {"operation": "all"}:
                return {"records": [{"roundId": 1}], "nextCursor": "page:1"}
            if request == {"operation": "all", "cursor": "page:1"}:
                return {"records": [{"roundId": 2}]}
            if request == {"operation": "round", "roundId": 11}:
                return {"record": {"postIds": ["alice-post-1", "alice-post-2", "alice-post-3"]}}
            if request == {"operation": "round", "roundId": 12}:
                return {"record": {"postIds": ["bob-post-1", "bob-post-2", "bob-post-3"]}}
            raise AssertionError(f"unexpected request: {request}")

        status, result = execute_child(feed_payload(), history_client=history_client)

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result, {
            "feeds": [
                {"actorId": "alice", "postIds": ["alice-post-1", "alice-post-2"]},
                {"actorId": "bob", "postIds": ["bob-post-1", "bob-post-2"]},
            ],
        })
        self.assertEqual(collections.Counter(
            (request["operation"], request.get("cursor"), request.get("roundId")) for request in calls
        ), collections.Counter({
            ("all", None, None): 2,
            ("all", "page:1", None): 2,
            ("round", None, 11): 1,
            ("round", None, 12): 1,
        }))

    def test_rejects_the_legacy_function_and_snapshot_constructor_contracts(self) -> None:
        status, result = execute_child({
            "mode": "validate",
            "source": "CONFIG_SCHEMA = {}\nDEFAULT_CONFIG = {}\ndef generate_feeds(snapshot, config, context): return []",
            "dependencies": [],
            "limits": LIMITS,
        })

        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("FeedAlgorithm class must be defined", result["error"])

        status, result = execute_child({
            "mode": "validate",
            "source": SOURCE.replace(
                "def __init__(self, config, context):",
                "def __init__(self, snapshot, config, context):",
            ),
            "dependencies": [],
            "limits": LIMITS,
        })
        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("FeedAlgorithm constructor must be FeedAlgorithm(config, context)", result["error"])

    def test_validation_exposes_only_an_unavailable_social_history(self) -> None:
        source = """
class FeedAlgorithm:
    CONFIG_SCHEMA = {}
    DEFAULT_CONFIG = {}
    def __init__(self, config, context):
        list(context["socialHistory"].all())
    def rank(self, actor_id):
        return []
"""
        status, result = execute_child({
            "mode": "validate",
            "source": source,
            "dependencies": [],
            "limits": LIMITS,
        })

        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("socialHistory is not available during validation", result["error"])

    def test_rejects_snapshot_payload_and_non_post_id_rank_output(self) -> None:
        legacy_payload = feed_payload()
        legacy_payload["snapshot"] = {"posts": []}
        status, result = execute_child(legacy_payload)
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("does not accept snapshot", result["error"])

        status, result = execute_child(feed_payload(SOURCE.replace(
            'return selected["postIds"][:self.context["feedSize"]] if record_count == 2 else []',
            "return actor_id",
        )), history_client=lambda _history, request: (
            {"records": []} if request["operation"] == "all" else {"record": {"postIds": []}}
        ))

        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("must return list[str]", result["error"])


class MarketMakerRunnerTests(unittest.TestCase):
    def test_allows_declared_plain_and_from_imports(self) -> None:
        for source in (
            "import math\n" + MARKET_MAKER_SOURCE,
            "from math import exp\n" + MARKET_MAKER_SOURCE,
        ):
            status, result = execute_child({
                "algorithmKind": "market_maker",
                "mode": "validate",
                "source": source,
                "dependencies": ["math"],
                "limits": LIMITS,
            })
            self.assertEqual(status, HTTPStatus.OK)
            self.assertTrue(result["valid"])

    def test_rejects_relative_and_undeclared_imports(self) -> None:
        for source, dependencies in (
            ("from .math import exp\n" + MARKET_MAKER_SOURCE, ["math"]),
            ("import os\n" + MARKET_MAKER_SOURCE, []),
        ):
            status, result = execute_child({
                "algorithmKind": "market_maker",
                "mode": "validate",
                "source": source,
                "dependencies": dependencies,
                "limits": LIMITS,
            })
            self.assertEqual(status, HTTPStatus.BAD_REQUEST)
            self.assertIn("imports are restricted", result["error"])

    def test_validates_the_market_maker_class_contract(self) -> None:
        status, result = execute_child({
            "algorithmKind": "market_maker",
            "mode": "validate",
            "source": MARKET_MAKER_SOURCE,
            "dependencies": [],
            "limits": LIMITS,
        })

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result, {
            "valid": True,
            "configSchema": {"type": "object"},
            "defaultConfig": {"size": 2},
        })

    def test_executes_against_only_the_constrained_history_proxy(self) -> None:
        calls: list[dict[str, object]] = []

        def history_client(history: dict[str, str], request: dict[str, object]) -> dict[str, object]:
            self.assertEqual(history, {
                "endpoint": "http://financial-market:3000/internal/market-maker-history",
                "capability": "opaque-history-capability",
            })
            calls.append(request)
            if request == {"operation": "all"}:
                return {"records": [{"roundId": 1}], "nextCursor": "cursor:1"}
            if request == {"operation": "all", "cursor": "cursor:1"}:
                return {"records": [{"roundId": 2}]}
            if request == {"operation": "round", "roundId": 3}:
                return {"record": {"summary": {"lastTradePrice": 101.25}}}
            if request == {"operation": "makerAccount"}:
                return {"account": {"position": 5}}
            if request == {"operation": "participantBaseline"}:
                return {"baseline": {"accountCount": 3, "totalCash": 1_000, "totalPosition": 30}}
            raise AssertionError(f"unexpected request: {request}")

        status, result = execute_child(market_maker_payload(), history_client=history_client)

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result, {"orders": [{"side": "buy", "limitPrice": 101.25, "quantity": 12}]})
        self.assertEqual(calls, [
            {"operation": "all"},
            {"operation": "all", "cursor": "cursor:1"},
            {"operation": "round", "roundId": 3},
            {"operation": "makerAccount"},
            {"operation": "participantBaseline"},
        ])

    def test_rejects_non_intent_output_and_feed_contract(self) -> None:
        invalid_order = """
class MarketMaker:
    CONFIG_SCHEMA = {}
    DEFAULT_CONFIG = {}
    def __init__(self, config, context): pass
    def quote(self):
        return [{"side": "buy", "limitPrice": 10, "quantity": 1, "expiresAtRound": 5}]
"""
        status, result = execute_child(market_maker_payload(invalid_order), history_client=lambda _history, _request: {"records": []})
        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("exactly side, limitPrice, quantity", result["error"])

        status, result = execute_child({
            "algorithmKind": "market_maker",
            "mode": "validate",
            "source": SOURCE,
            "dependencies": [],
            "limits": LIMITS,
        })
        self.assertEqual(status, HTTPStatus.UNPROCESSABLE_ENTITY)
        self.assertIn("MarketMaker class must be defined", result["error"])

    def test_inventory_ladder_uses_signed_market_maker_flow_and_round_open_center(self) -> None:
        external_buy = [{
            "roundId": 2,
            "price": 500,
            "quantity": 20,
            "makerSide": "sell",
        }]
        external_sell = [{
            "roundId": 2,
            "price": 500,
            "quantity": 20,
            "makerSide": "buy",
        }]
        unrelated = [{
            "roundId": 2,
            "price": 500,
            "quantity": 20,
            "makerSide": None,
        }]

        buy_status, buy = execute_child(
            inventory_ladder_payload(),
            history_client=inventory_history(external_buy),
        )
        sell_status, sell = execute_child(
            inventory_ladder_payload(),
            history_client=inventory_history(external_sell),
        )
        neutral_status, neutral = execute_child(
            inventory_ladder_payload(),
            history_client=inventory_history(unrelated),
        )

        self.assertEqual((buy_status, sell_status, neutral_status), (HTTPStatus.OK,) * 3)
        buy_bid = max(order["limitPrice"] for order in buy["orders"] if order["side"] == "buy")
        sell_bid = max(order["limitPrice"] for order in sell["orders"] if order["side"] == "buy")
        neutral_bid = max(order["limitPrice"] for order in neutral["orders"] if order["side"] == "buy")
        self.assertGreater(buy_bid, neutral_bid)
        self.assertLess(sell_bid, neutral_bid)
        self.assertLess(neutral_bid, 200)

    def test_inventory_ladder_depletes_pressured_size_and_conserves_ladder_budget(self) -> None:
        pressure = [{
            "roundId": 2,
            "price": 101,
            "quantity": 40,
            "makerSide": "sell",
        }]
        calm_status, calm = execute_child(
            inventory_ladder_payload({"baseOrderSize": 100, "quoteLevels": 10}),
            history_client=inventory_history([]),
        )
        pressure_status, stressed = execute_child(
            inventory_ladder_payload({"baseOrderSize": 100, "quoteLevels": 10}),
            history_client=inventory_history(pressure),
        )

        self.assertEqual((calm_status, pressure_status), (HTTPStatus.OK, HTTPStatus.OK))
        calm_bids = [order for order in calm["orders"] if order["side"] == "buy"]
        calm_asks = [order for order in calm["orders"] if order["side"] == "sell"]
        stressed_asks = [order for order in stressed["orders"] if order["side"] == "sell"]
        self.assertEqual(sum(order["quantity"] for order in calm_bids), 100)
        self.assertEqual(sum(order["quantity"] for order in calm_asks), 100)
        self.assertLess(
            sum(order["quantity"] for order in stressed_asks),
            sum(order["quantity"] for order in calm_asks),
        )
        self.assertLess(max(order["limitPrice"] for order in calm_bids), min(order["limitPrice"] for order in calm_asks))

    def test_inventory_ladder_uses_replacement_budget_instead_of_raw_reservations(self) -> None:
        def history_client(history: dict[str, str], request: dict[str, object]) -> dict[str, object]:
            response = inventory_history([])(history, request)
            if request == {"operation": "makerAccount"}:
                response["account"].update({
                    "reservedCash": 99_900,
                    "reservedPosition": 100,
                    "replacementAvailableCash": 100_000,
                    "replacementAvailablePosition": 100,
                })
            return response

        status, result = execute_child(
            inventory_ladder_payload({"baseOrderSize": 100, "quoteLevels": 10}),
            history_client=history_client,
        )

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(sum(order["quantity"] for order in result["orders"] if order["side"] == "buy"), 100)
        self.assertEqual(sum(order["quantity"] for order in result["orders"] if order["side"] == "sell"), 100)

    def test_inventory_ladder_derives_depth_from_the_initial_participant_baseline(self) -> None:
        status, result = execute_child(
            inventory_ladder_payload({
                "quoteSize": {
                    "mode": "relative_to_total_participant_inventory",
                    "targetSideDepthRatio": 0.25,
                    "minSideDepth": 1,
                    "maxSideDepth": 5_000,
                },
                "quoteLevels": 10,
            }),
            history_client=inventory_history([]),
        )

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(
            sum(order["quantity"] for order in result["orders"] if order["side"] == "buy"),
            75,
        )
        self.assertEqual(
            sum(order["quantity"] for order in result["orders"] if order["side"] == "sell"),
            75,
        )

    def test_inventory_ladder_gamma_shape_retreats_from_near_ask_levels_under_buy_pressure(self) -> None:
        pressure = [{
            "roundId": 2,
            "price": 101,
            "quantity": 40,
            "makerSide": "sell",
        }]
        config = {
            "baseOrderSize": 100,
            "quoteLevels": 10,
            "ladderShape": "gamma",
            "riskModel": {"liquidityDepletionSizeFraction": 0},
        }
        calm_status, calm = execute_child(
            inventory_ladder_payload(config),
            history_client=inventory_history([]),
        )
        pressure_status, stressed = execute_child(
            inventory_ladder_payload(config),
            history_client=inventory_history(pressure),
        )

        self.assertEqual((calm_status, pressure_status), (HTTPStatus.OK, HTTPStatus.OK))
        calm_asks = [order["quantity"] for order in calm["orders"] if order["side"] == "sell"]
        stressed_asks = [order["quantity"] for order in stressed["orders"] if order["side"] == "sell"]
        self.assertEqual(sum(calm_asks), sum(stressed_asks))
        self.assertLess(sum(stressed_asks[:3]), sum(calm_asks[:3]))


if __name__ == "__main__":
    unittest.main()
