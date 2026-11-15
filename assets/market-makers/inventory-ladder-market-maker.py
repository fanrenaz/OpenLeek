import math


class MarketMaker:
    CONFIG_SCHEMA = {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "quoteCenter",
            "baseOrderSize",
            "quoteSize",
            "inventoryTarget",
            "inventoryCapacity",
            "minSpreadBps",
            "maxSpreadBps",
            "volatilitySpreadMultiplier",
            "minSizeMultiplier",
            "maxSizeMultiplier",
            "riskModel",
            "quoteLevels",
            "ladderDistance",
            "levelSizeDecay",
            "minLevelSize",
            "ladderShape",
            "ladderPeakLevel",
            "ladderSigma",
            "gammaLadder",
        ],
        "properties": {
            "quoteCenter": {"type": "string", "enum": ["round_open", "latest_trade"]},
            "baseOrderSize": {"type": "integer", "minimum": 1},
            "quoteSize": {"type": "object"},
            "inventoryTarget": {"type": "object"},
            "inventoryCapacity": {"type": "object"},
            "minSpreadBps": {"type": "number", "minimum": 0},
            "maxSpreadBps": {"type": "number", "minimum": 0},
            "volatilitySpreadMultiplier": {"type": "number", "minimum": 0},
            "minSizeMultiplier": {"type": "number", "minimum": 0},
            "maxSizeMultiplier": {"type": "number", "minimum": 0},
            "riskModel": {"type": "object"},
            "quoteLevels": {"type": "integer", "minimum": 1, "maximum": 100},
            "ladderDistance": {"type": "object"},
            "levelSizeDecay": {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
            "minLevelSize": {"type": "integer", "minimum": 1},
            "ladderShape": {"type": "string", "enum": ["normal", "exponential", "gamma"]},
            "ladderPeakLevel": {"type": "number", "minimum": 1},
            "ladderSigma": {"type": "number", "exclusiveMinimum": 0},
            "gammaLadder": {"type": "object"},
        },
    }

    DEFAULT_CONFIG = {
        "quoteCenter": "round_open",
        "baseOrderSize": 10,
        "quoteSize": {
            "mode": "relative_to_total_participant_inventory",
            "targetSideDepthRatio": 0.25,
            "minSideDepth": 200,
            "maxSideDepth": 5000,
            "fraction": 0.1,
            "minSize": 1,
            "maxSize": 100,
        },
        "inventoryTarget": {
            "mode": "asset_value_fraction",
            "fraction": 0.5,
            "quantity": 0,
        },
        "inventoryCapacity": {
            "mode": "auto",
            "quantity": 1,
        },
        "minSpreadBps": 2,
        "maxSpreadBps": 100,
        "volatilitySpreadMultiplier": 1.0,
        "minSizeMultiplier": 0.5,
        "maxSizeMultiplier": 4.0,
        "riskModel": {
            "orderFlowWindowTrades": 500,
            "informationImpactBps": 300,
            "informationImpactCurve": 1.15,
            "inventoryReservationBps": 250,
            "inventorySpreadBps": 120,
            "adverseSelectionBps": 20,
            "liquidityDepletionBps": 160,
            "liquidityDepletionSizeFraction": 0.75,
        },
        "quoteLevels": 10,
        "ladderDistance": {
            "minBps": 5,
            "maxBps": 300,
            "curve": 1.6,
            "pressureNearWidenBps": 30,
            "pressureFarWidenBps": 500,
            "pressureCurve": 1.3,
        },
        "levelSizeDecay": 0.85,
        "minLevelSize": 1,
        "ladderShape": "normal",
        "ladderPeakLevel": 4.0,
        "ladderSigma": 2.0,
        "gammaLadder": {
            "peakFraction": 0.5,
            "maxRetreatFraction": 0.25,
            "concentration": 2.0,
            "tailFatness": 0.5,
        },
    }

    def __init__(self, config, context):
        self.config = self._merge(self.DEFAULT_CONFIG, config)
        self.history = context["financialHistory"]
        self.round_id = int(context["roundId"])
        self._validate()

    def quote(self):
        records = list(self.history.all())
        account = self.history.makerAccount()
        baseline = self.history.participantBaseline()
        current = self._current_record(records)
        self.tick_size = self._tick_size(records, current, account)
        reference = self._reference_price(records, current)
        base_order_size = self._base_order_size(baseline)

        cash = max(0.0, float(account["replacementAvailableCash"]))
        asset = max(0, int(account["replacementAvailablePosition"]))
        target = self._target_asset(account, reference)
        capacity = self._inventory_capacity(asset, target, base_order_size)
        inventory_ratio = self._clamp((asset - target) / capacity, -1.0, 1.0)

        flow = self._order_flow(records, base_order_size)
        risk = self.config["riskModel"]
        signed_pressure = math.copysign(
            (abs(flow["imbalance"]) * flow["intensity"]) ** risk["informationImpactCurve"],
            flow["imbalance"],
        )
        fair_value = max(self.tick_size, reference * (1 + risk["informationImpactBps"] * signed_pressure / 10000))
        reservation = max(self.tick_size, fair_value * (1 - risk["inventoryReservationBps"] * inventory_ratio / 10000))

        spread_bps = (
            self.config["minSpreadBps"]
            + risk["adverseSelectionBps"] * flow["intensity"]
            + risk["liquidityDepletionBps"] * flow["intensity"] * abs(flow["imbalance"])
            + risk["inventorySpreadBps"] * abs(inventory_ratio)
            + self._realized_volatility(records) * 10000 * self.config["volatilitySpreadMultiplier"]
        )
        spread_bps = self._clamp(
            spread_bps,
            self.config["minSpreadBps"],
            self.config["maxSpreadBps"],
        )
        half_spread = max(self.tick_size, reservation * spread_bps / 20000)
        top_bid = self._quantize(reservation - half_spread, "buy")
        top_ask = max(top_bid + self.tick_size, self._quantize(reservation + half_spread, "sell"))

        buy_pressure = max(0.0, flow["imbalance"]) * flow["intensity"]
        sell_pressure = max(0.0, -flow["imbalance"]) * flow["intensity"]
        bid_budget = round(
            base_order_size
            * self._clamp(
                1.0 - inventory_ratio,
                self.config["minSizeMultiplier"],
                self.config["maxSizeMultiplier"],
            )
        )
        ask_budget = round(
            base_order_size
            * self._clamp(
                1.0 + inventory_ratio,
                self.config["minSizeMultiplier"],
                self.config["maxSizeMultiplier"],
            )
        )
        bid_budget = round(
            bid_budget
            * (1.0 - risk["liquidityDepletionSizeFraction"] * sell_pressure)
        )
        ask_budget = round(
            ask_budget
            * (1.0 - risk["liquidityDepletionSizeFraction"] * buy_pressure)
        )
        bid_budget = max(0, min(bid_budget, math.floor(cash / top_bid)))
        ask_budget = max(0, min(ask_budget, asset))

        bid_pressure = self._clamp(inventory_ratio + sell_pressure, 0.0, 1.0)
        ask_pressure = self._clamp(-inventory_ratio + buy_pressure, 0.0, 1.0)
        bids = self._ladder("buy", top_bid, reservation, bid_budget, bid_pressure)
        asks = self._ladder("sell", top_ask, reservation, ask_budget, ask_pressure)
        return bids + asks

    def _current_record(self, records):
        matches = [record for record in records if int(record["roundId"]) == self.round_id]
        return matches[-1] if matches else None

    def _reference_price(self, records, current):
        if self.config["quoteCenter"] == "round_open":
            if current is not None:
                return max(self.tick_size, float(current["openingReferencePrice"]))
            if records:
                return max(self.tick_size, float(records[-1]["summary"]["lastTradePrice"]))
            return self.tick_size
        if current is not None and current["trades"]:
            return max(self.tick_size, float(current["trades"][-1]["price"]))
        if records:
            return max(self.tick_size, float(records[-1]["summary"]["lastTradePrice"]))
        return self.tick_size

    def _tick_size(self, records, current, account):
        value = (current or {}).get("tickSize")
        if value is None and records:
            value = records[-1].get("tickSize")
        if value is None:
            value = account.get("tickSize", 1)
        return max(1e-8, float(value))

    def _quantize(self, price, side):
        units = price / self.tick_size
        snapped = math.floor(units + 1e-10) if side == "buy" else math.ceil(units - 1e-10)
        return max(self.tick_size, round(snapped * self.tick_size, 8))

    def _base_order_size(self, baseline):
        policy = self.config["quoteSize"]
        mode = policy["mode"]
        if mode == "fixed":
            return int(self.config["baseOrderSize"])
        total = max(0, int(baseline["totalPosition"]))
        count = max(0, int(baseline["accountCount"]))
        if mode == "relative_to_total_participant_inventory":
            computed = round(total * policy["targetSideDepthRatio"])
            return int(self._clamp(computed, policy["minSideDepth"], policy["maxSideDepth"]))
        average = 0 if count == 0 else total / count
        computed = round(average * policy["fraction"])
        return int(self._clamp(computed, policy["minSize"], policy["maxSize"]))

    def _target_asset(self, account, reference):
        policy = self.config["inventoryTarget"]
        if policy["mode"] == "fixed":
            return max(0, int(policy["quantity"]))
        cash = max(0.0, float(account["cash"]))
        asset = max(0, int(account["position"]))
        total_value = cash + asset * reference
        return max(0, round(total_value * policy["fraction"] / max(1, reference)))

    def _inventory_capacity(self, asset, target, base_order_size):
        policy = self.config["inventoryCapacity"]
        if policy["mode"] == "fixed":
            return max(1, int(policy["quantity"]))
        return max(1, target, abs(asset - target), base_order_size * 10)

    def _order_flow(self, records, base_order_size):
        trades = []
        for record in records:
            trades.extend(record.get("trades", []))
        window = int(self.config["riskModel"]["orderFlowWindowTrades"])
        recent = trades[-window:]
        external_buy = 0
        external_sell = 0
        trade_count = 0
        for trade in recent:
            if int(trade["roundId"]) != self.round_id:
                continue
            quantity = max(0, int(trade["quantity"]))
            if quantity <= 0:
                continue
            if trade.get("makerSide") == "sell":
                external_buy += quantity
            elif trade.get("makerSide") == "buy":
                external_sell += quantity
            trade_count += 1
        total = external_buy + external_sell
        return {
            "externalBuyQuantity": external_buy,
            "externalSellQuantity": external_sell,
            "tradeCount": trade_count,
            "imbalance": 0.0 if total == 0 else (external_buy - external_sell) / total,
            "intensity": self._clamp(total / max(1, base_order_size * 2), 0.0, 1.0),
        }

    def _realized_volatility(self, records):
        closes = [max(self.tick_size, float(record["summary"]["lastTradePrice"])) for record in records]
        window = 5
        if len(closes) < window + 1:
            return 0.0
        closes = closes[-(window + 1):]
        returns = [
            (closes[index] - closes[index - 1]) / closes[index - 1]
            for index in range(1, len(closes))
        ]
        mean = sum(returns) / len(returns)
        variance = sum((item - mean) ** 2 for item in returns) / len(returns)
        return math.sqrt(variance)

    def _ladder(self, side, top, center, total, pressure):
        sizes = self._level_sizes(total, pressure)
        distances = self._level_distances(center, pressure)
        result = []
        for index, quantity in enumerate(sizes):
            if quantity <= 0:
                continue
            if quantity < self.config["minLevelSize"] and index > 0:
                break
            price = top - distances[index] if side == "buy" else top + distances[index]
            result.append({"side": side, "limitPrice": self._quantize(price, side), "quantity": int(quantity)})
        return result

    def _level_distances(self, center, pressure):
        policy = self.config["ladderDistance"]
        count = int(self.config["quoteLevels"])
        values = []
        for index in range(count):
            t = 0.0 if count == 1 else index / (count - 1)
            base_bps = policy["minBps"] + (
                policy["maxBps"] - policy["minBps"]
            ) * (t ** policy["curve"])
            pressure_bps = pressure * (
                policy["pressureNearWidenBps"]
                + (policy["pressureFarWidenBps"] - policy["pressureNearWidenBps"])
                * (t ** policy["pressureCurve"])
            )
            values.append(max(0.0, center * (base_bps + pressure_bps) / 10000))
        return values

    def _level_sizes(self, total, pressure):
        count = int(self.config["quoteLevels"])
        if total <= 0:
            return [0 for _ in range(count)]
        shape = self.config["ladderShape"]
        if shape == "gamma":
            weights = self._gamma_weights(count, pressure)
        elif shape == "normal":
            peak = min(float(count), float(self.config["ladderPeakLevel"]))
            sigma = float(self.config["ladderSigma"])
            weights = [
                math.exp(-0.5 * (((level - peak) / sigma) ** 2))
                for level in range(1, count + 1)
            ]
        else:
            decay = float(self.config["levelSizeDecay"])
            weights = [decay ** (level - 1) for level in range(1, count + 1)]
        return self._allocate_integer_budget(int(total), weights)

    def _gamma_weights(self, levels, pressure):
        policy = self.config["gammaLadder"]
        target_peak = max(
            0.01,
            levels * (policy["peakFraction"] + policy["maxRetreatFraction"] * pressure),
        )
        shape = max(1.01, policy["concentration"] / (1 + policy["tailFatness"] * pressure))
        mean_level = target_peak * shape / (shape - 1)
        theta = max(0.01, mean_level / shape)
        values = []
        for level in range(1, levels + 1):
            log_weight = (
                (shape - 1) * math.log(level)
                - level / theta
                - math.lgamma(shape)
                - shape * math.log(theta)
            )
            values.append(math.exp(log_weight))
        return values

    def _allocate_integer_budget(self, total, weights):
        positive = [max(0.0, float(weight)) for weight in weights]
        weight_sum = sum(positive)
        if total <= 0 or weight_sum <= 0:
            return [0 for _ in weights]
        active = [index for index, weight in enumerate(positive) if weight > 0]
        sizes = [0 for _ in weights]
        if total >= len(active):
            for index in active:
                sizes[index] = 1
            allocatable = total - len(active)
        else:
            allocatable = total
        if allocatable <= 0:
            return sizes
        raw = [allocatable * weight / weight_sum for weight in positive]
        increments = [int(value) for value in raw]
        sizes = [size + increment for size, increment in zip(sizes, increments)]
        remainder = total - sum(sizes)
        order = sorted(
            range(len(raw)),
            key=lambda index: (raw[index] - increments[index], -index),
            reverse=True,
        )
        for index in order[:remainder]:
            sizes[index] += 1
        return sizes

    def _validate(self):
        config = self.config
        if config["quoteCenter"] not in {"round_open", "latest_trade"}:
            raise ValueError("quoteCenter must be round_open or latest_trade")
        if int(config["baseOrderSize"]) < 1:
            raise ValueError("baseOrderSize must be >= 1")
        if config["quoteSize"]["mode"] not in {
            "fixed",
            "relative_to_total_participant_inventory",
            "relative_to_average_participant_inventory",
        }:
            raise ValueError("quoteSize.mode is invalid")
        if config["inventoryTarget"]["mode"] not in {"fixed", "asset_value_fraction"}:
            raise ValueError("inventoryTarget.mode is invalid")
        if config["inventoryCapacity"]["mode"] not in {"auto", "fixed"}:
            raise ValueError("inventoryCapacity.mode is invalid")
        if config["maxSpreadBps"] < config["minSpreadBps"]:
            raise ValueError("maxSpreadBps must be >= minSpreadBps")
        if config["maxSizeMultiplier"] < config["minSizeMultiplier"]:
            raise ValueError("maxSizeMultiplier must be >= minSizeMultiplier")
        if not 0 <= config["riskModel"]["liquidityDepletionSizeFraction"] <= 1:
            raise ValueError("liquidityDepletionSizeFraction must be between 0 and 1")
        if int(config["riskModel"]["orderFlowWindowTrades"]) < 1:
            raise ValueError("orderFlowWindowTrades must be >= 1")
        if int(config["quoteLevels"]) < 1:
            raise ValueError("quoteLevels must be >= 1")
        if config["ladderShape"] not in {"normal", "exponential", "gamma"}:
            raise ValueError("ladderShape is invalid")

    def _merge(self, base, override):
        result = {}
        for key, value in base.items():
            if isinstance(value, dict):
                replacement = override.get(key, {})
                result[key] = self._merge(
                    value,
                    replacement if isinstance(replacement, dict) else {},
                )
            else:
                result[key] = override.get(key, value)
        for key, value in override.items():
            if key not in result:
                result[key] = value
        return result

    def _clamp(self, value, low, high):
        return max(low, min(high, value))
