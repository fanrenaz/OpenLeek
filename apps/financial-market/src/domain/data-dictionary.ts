import {
  dataDictionarySourceSchema,
  toDataDictionaryJsonSchema,
  type DataDictionarySource,
} from "@openleek/contracts/data-dictionary";
import { financialCommittedFactsSchema } from "@openleek/contracts/observability";

const text = (en: string, zh: string) => ({
  default: en,
  translations: { en, zh },
});

const allowedImports = [
  "math", "statistics", "random", "json", "collections", "itertools",
  "functools", "datetime", "numpy", "networkx", "scipy", "pandas", "sklearn",
];
const limits = { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 };

const historyRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["roundId", "tickSize", "referencePrice", "openingReferencePrice", "summary", "trades", "bidDepth", "askDepth"],
  properties: {
    roundId: { type: "integer", minimum: 0 },
    tickSize: { type: "number", exclusiveMinimum: 0 },
    referencePrice: { type: "number", exclusiveMinimum: 0 },
    openingReferencePrice: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Round-opening reference captured before this round's orders and trades.",
    },
    summary: {
      type: "object",
      required: ["roundId", "lastTradePrice", "volume", "bestBid", "bestAsk", "openOrderCount"],
      properties: {
        roundId: { type: "integer", minimum: 0 },
        lastTradePrice: { type: "number", minimum: 0 },
        volume: { type: "integer", minimum: 0 },
        bestBid: { type: "number", minimum: 0 },
        bestAsk: { type: "number", minimum: 0 },
        openOrderCount: { type: "integer", minimum: 0 },
      },
    },
    trades: {
      type: "array",
      items: {
        type: "object",
        required: ["roundId", "price", "quantity", "makerSide"],
        properties: {
          roundId: { type: "integer", minimum: 0 },
          price: { type: "number", exclusiveMinimum: 0 },
          quantity: { type: "integer", minimum: 1 },
          makerSide: {
            type: ["string", "null"],
            enum: ["buy", "sell", null],
            description: "The Market Maker side for this fill, or null when the Market Maker was not a party.",
          },
        },
      },
    },
    bidDepth: { type: "array", items: { type: "object", properties: { price: { type: "number" }, quantity: { type: "integer" } } } },
    askDepth: { type: "array", items: { type: "object", properties: { price: { type: "number" }, quantity: { type: "integer" } } } },
  },
};

export const financialDataDictionary: DataDictionarySource = dataDictionarySourceSchema.parse({
  schemaVersion: "1",
  ownerId: "financial",
  owner: text("Financial Market", "金融市场"),
  revision: "financial-domain:2026-08-06-market-maker-replacement-budget",
  entries: [
    {
      schemaVersion: "1",
      id: "financial-preset",
      ownerId: "financial",
      categoryId: "agent",
      entryKind: "asset",
      management: { surface: "asset-library", key: "financial-preset", idField: "presetId", capabilities: ["list", "read", "save-draft", "publish", "delete-draft", "delete-version"] },
      label: text("Financial Initial State Preset", "金融初始状态预设"),
      description: text(
        "Reusable fixed or formula-derived starting funds, referenced by exact immutable version.",
        "可复用的固定或公式派生初始资金，通过精确不可变版本引用。",
      ),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "Financial Initial State Preset",
        additionalProperties: false,
        required: ["name", "mode"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          mode: { type: "string", enum: ["fixed", "deterministic_issuance", "population_relative"] },
          cash: { type: "number", minimum: 0, description: "Initial unreserved cash." },
          positions: {
            type: "object",
            default: {},
            maxProperties: 1_000,
            description: "Instrument symbol to non-negative starting quantity.",
            additionalProperties: { type: "number", minimum: 0 },
          },
          symbol: { type: "string", minLength: 1, maxLength: 32 },
          issuePrice: { type: "number", exclusiveMinimum: 0 },
          buckets: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["weight", "spendCashFraction"],
              properties: {
                weight: { type: "number", exclusiveMinimum: 0 },
                spendCashFraction: { type: "number", minimum: 0, maximum: 1 },
              },
            },
          },
          seedSalt: { type: "string", minLength: 1, maxLength: 240 },
          sourcePresetVersionRefs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          wealthFraction: { type: "number", minimum: 0, maximum: 1 },
          targetAssetValueFraction: { type: "number", minimum: 0, maximum: 1 },
        },
        oneOf: [
          { properties: { mode: { const: "fixed" } }, required: ["cash", "positions"] },
          { properties: { mode: { const: "deterministic_issuance" } }, required: ["cash", "symbol", "issuePrice", "buckets", "seedSalt"] },
          { properties: { mode: { const: "population_relative" } }, required: ["sourcePresetVersionRefs", "wealthFraction", "targetAssetValueFraction", "symbol"] },
        ],
      },
      references: [],
      examples: [{
        title: text("LEEK investor account", "LEEK 投资者账户"),
        value: { name: "Balanced LEEK account", mode: "fixed", cash: 25_000, positions: { LEEK: 120 } },
      }],
    },
    {
      schemaVersion: "1",
      id: "market-maker",
      ownerId: "financial",
      categoryId: "world",
      entryKind: "asset",
      management: { surface: "asset-library", key: "market-maker", idField: "algorithmId", capabilities: ["list", "read", "validate", "preview", "save-draft", "publish", "delete-draft", "delete-version"] },
      label: text("Market Maker", "做市商"),
      description: text(
        "A Financial-owned Python policy that reads committed market history and returns quote order intents.",
        "由 Financial 持有的 Python 策略，读取已提交市场历史并返回报价订单意图。",
      ),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "Market Maker asset",
        additionalProperties: false,
        required: ["name", "source", "defaultConfig", "dependencies", "limits"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          source: { type: "string", minLength: 1, maxLength: 250_000 },
          defaultConfig: { type: "object", default: {} },
          dependencies: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", enum: allowedImports } },
          limits: {
            type: "object",
            required: ["maxRuntimeMs", "maxMemoryMb"],
            properties: {
              maxRuntimeMs: { type: "integer", minimum: 1, maximum: 60_000 },
              maxMemoryMb: { type: "integer", minimum: 64, maximum: 1_024 },
            },
          },
        },
      },
      references: [{ path: "selection.initialStatePresetVersionRef", targetEntryId: "financial-preset" }],
      examples: [{
        title: text("No-op maker", "无操作做市商"),
        value: {
          name: "No quotes",
          source: "class MarketMaker:\n    CONFIG_SCHEMA = {'type': 'object'}\n    DEFAULT_CONFIG = {}\n    def __init__(self, config, context): self.context = context\n    def quote(self): return []\n",
          defaultConfig: {},
          dependencies: [],
          limits,
        },
      }],
      programming: {
        language: "python",
        className: "MarketMaker",
        constructor: "MarketMaker(config, context)",
        methods: [{
          signature: "quote() -> list[dict]",
          description: text(
            "Returns order intents with exactly side, limitPrice and quantity. Prices are decimal currency units aligned to tickSize; quantities are whole units.",
            "返回仅包含 side、limitPrice 和 quantity 的订单意图。价格为按 tickSize 对齐的小数货币单位，数量为整数单位。",
          ),
        }],
        contextSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          required: ["seed", "roundId", "timing", "financialHistory"],
          properties: {
            seed: { type: "string" },
            roundId: { type: "integer", minimum: 0 },
            timing: { type: "string", enum: ["opening", "settlement"] },
            financialHistory: {
              type: "object",
              description: "Capability-bound reader for one committed Financial lineage.",
              properties: {
                all: { type: "string", description: "all() -> iterator[history record]" },
                round: { type: "string", description: "round(round_id) -> history record" },
                makerAccount: {
                  type: "object",
                  description: "makerAccount() result.",
                  required: ["accountId", "cash", "position", "reservedCash", "reservedPosition", "replacementAvailableCash", "replacementAvailablePosition"],
                  properties: {
                    accountId: { type: "string" },
                    cash: { type: "number", minimum: 0 },
                    position: { type: "integer", minimum: 0 },
                    reservedCash: { type: "number", minimum: 0 },
                    reservedPosition: { type: "integer", minimum: 0 },
                    replacementAvailableCash: {
                      type: "number",
                      minimum: 0,
                      description: "Cash available for a replacement quote set after releasing this account's open Market Maker buy orders; other reservations remain binding.",
                    },
                    replacementAvailablePosition: {
                      type: "integer",
                      minimum: 0,
                      description: "Position available for a replacement quote set after releasing this account's open Market Maker sell orders; other reservations remain binding.",
                    },
                  },
                },
                participantBaseline: {
                  type: "object",
                  description: "participantBaseline() result from the initial committed snapshot, excluding the Market Maker account.",
                  required: ["accountCount", "totalCash", "totalPosition"],
                  properties: {
                    accountCount: { type: "integer", minimum: 0 },
                    totalCash: { type: "number", minimum: 0 },
                    totalPosition: { type: "integer", minimum: 0 },
                  },
                },
                record: historyRecordSchema,
              },
            },
          },
        },
        resultSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["side", "limitPrice", "quantity"],
            properties: {
              side: { type: "string", enum: ["buy", "sell"] },
              limitPrice: { type: "number", exclusiveMinimum: 0, description: "Currency-unit price aligned to the instrument tickSize." },
              quantity: { type: "integer", minimum: 1 },
            },
          },
        },
        allowedImports,
        limits,
        exampleSource: `class MarketMaker:
    CONFIG_SCHEMA = {"type": "object"}
    DEFAULT_CONFIG = {}

    def __init__(self, config, context):
        self.history = context["financialHistory"]

    def quote(self):
        return []
`,
      },
    },
    {
      schemaVersion: "1",
      id: "financial-committed-facts",
      ownerId: "financial",
      categoryId: "experiment",
      entryKind: "evidence",
      management: { surface: "run", key: "financial-committed-facts", idField: "revisionRef", capabilities: ["read"] },
      label: text("Financial committed facts", "金融已提交事实"),
      description: text("Trades and market summary from one committed Financial revision.", "一个已提交 Financial Revision 中的成交与市场汇总。"),
      definitionSchema: toDataDictionaryJsonSchema(financialCommittedFactsSchema),
      references: [],
      examples: [],
    },
    {
      schemaVersion: "1",
      id: "financial-observer-market",
      ownerId: "financial",
      categoryId: "experiment",
      entryKind: "projection",
      management: { surface: "run", key: "financial-observer-market", idField: "revisionRef", capabilities: ["read"] },
      label: text("Financial observer market", "金融观察者市场"),
      description: text("Account-free quote, candle, order-book, anonymous order and trade views for one committed Financial revision.", "一个已提交 Financial Revision 的无账户行情、K 线、盘口、匿名订单与成交视图。"),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["runId", "revisionRef"],
        properties: {
          runId: { type: "string" },
          revisionRef: { type: "string" },
          view: { type: "string", enum: ["snapshot", "trades", "orders"] },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
      references: [],
      examples: [],
    },
  ],
});
