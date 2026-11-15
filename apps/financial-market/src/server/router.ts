import { contextAssetCommandSchema, contextAssetReadSchema, contextPluginDescriptorSchema } from "@openleek/contracts/context";
import { domainProcedure, t } from "@openleek/trpc";
import { createFinancialMarketRouter, type FinancialMarketServiceProvider } from "../interfaces/trpc-router";
import { financialMarketRevisionService, financialMarketService } from "./runtime";
import { financialUiModuleSha256 } from "./ui-module";

/** Root router mounted at this standalone Context's `/api/trpc` endpoint. */
export function createFinancialMarketAppRouter(
  provider: FinancialMarketServiceProvider = financialMarketService,
  revisionProvider = financialMarketRevisionService,
) {
  const service = typeof provider === "function" ? provider : async () => provider;
  return t.router({
    contextPlugin: t.router({
      descriptor: domainProcedure.input(contextPluginDescriptorSchema.pick({}).strict()).query(() => ({
        schemaVersion: "3" as const,
        runtimeProtocol: "openleek-context-runtime/v2" as const,
        infrastructure: { postgres: true, redis: true },
        agentAccess: "read-write" as const,
        contextId: "financial",
        revision: "financial-context:v3",
        observerViews: [
          { id: "snapshot", label: { default: "Market", translations: { en: "Market", zh: "市场" } }, inputSchema: { type: "object" } },
          { id: "trades", label: { default: "Trades", translations: { en: "Trades", zh: "成交" } }, inputSchema: { type: "object" } },
          { id: "orders", label: { default: "Orders", translations: { en: "Orders", zh: "订单" } }, inputSchema: { type: "object" } },
        ],
        uiModule: { apiVersion: "openleek-context-ui/v1", path: "/api/context/v2/ui", sha256: financialUiModuleSha256, elements: { configuration: "openleek-financial-configuration", assets: "openleek-financial-assets", observer: "openleek-financial-observer", facts: "openleek-financial-facts" } },
        label: { default: "Financial Context", translations: { zh: "金融环境", en: "Financial Context" } },
        description: { default: "Accounts, markets and trading mechanisms.", translations: { zh: "管理账户、市场与交易机制。", en: "Accounts, markets and trading mechanisms." } },
        agentEnvironment: {
          accountPolicySchema: { type: "object", properties: { initialStatePresetVersionRef: { type: "string" }, maximumActionsPerRound: { type: "integer", minimum: 0, maximum: 1000, default: 3 } }, required: ["initialStatePresetVersionRef", "maximumActionsPerRound"] },
          accountPolicyUiSchema: {},
          capabilities: [
            ["financial.get_quote", "tool", "Get quote", "查询行情"],
            ["financial.get_order_book", "tool", "Get order book", "查询订单簿"],
            ["financial.get_candles", "tool", "Get candles", "查询K线"],
            ["financial.list_market_trades", "tool", "List market trades", "查询逐笔成交"],
            ["financial.list_market_orders", "tool", "List market orders", "查询逐笔挂单"],
            ["financial.get_account", "tool", "Get account", "查询账户"],
            ["financial.list_orders", "tool", "List orders", "查询订单"],
            ["financial.list_executions", "tool", "List executions", "查询成交"],
            ["financial.preview_order", "tool", "Preview order", "预览订单"],
            ["financial.place_order", "tool", "Place order", "下单"],
            ["financial.place_limit_order", "tool", "Place limit order", "限价下单"],
            ["financial.place_market_order", "tool", "Place market order", "市价下单"],
            ["financial.replace_order", "tool", "Replace order", "改单"],
            ["financial.cancel_order", "tool", "Cancel order", "撤单"],
            ["financial.market", "resource", "Market", "市场"],
            ["financial.account", "resource", "Account", "账户"],
            ["financial.orders", "resource", "Orders", "订单"],
          ].map(([id, kind, en, zh]) => ({ id, kind, label: { default: en, translations: { en, zh } } })),
        },
        worldEnvironment: {
          collections: [
            { id: "financial-presets", label: { default: "Financial Profiles", translations: { zh: "金融配置", en: "Financial Profiles" } }, description: { default: "Initial account state profiles.", translations: { zh: "定义账户初始状态。", en: "Initial account state profiles." } }, definitionSchema: { type: "object" }, uiSchema: { renderer: "financial-preset" }, actions: ["list", "draft", "save", "publish", "delete"] },
            { id: "market-makers", label: { default: "Market Makers", translations: { zh: "做市商", en: "Market Makers" } }, description: { default: "Market making policies.", translations: { zh: "定义市场中的做市机制。", en: "Market making policies." } }, definitionSchema: { type: "object" }, uiSchema: { renderer: "market-maker" }, actions: ["list", "draft", "save", "validate", "publish", "delete"] },
          ],
        },
        experimentConfigurationSchema: { type: "object", required: ["instruments"], properties: { instruments: { type: "array", minItems: 1 }, marketMaker: { type: "object" } } },
        experimentConfigurationUiSchema: {},
      })),
      assetRead: domainProcedure.input(contextAssetReadSchema.omit({ contextId: true })).query(async ({ input }): Promise<unknown> => {
        const instance = await service();
        if (input.collectionId === "financial-presets") {
          if (input.operation === "list") return instance.listFinancialInitialStatePresets(input.includeDeleted);
          if (input.operation === "draft" && input.id) return instance.getFinancialInitialStatePresetDraft(input.id, input.includeDeleted);
          if (input.operation === "version" && input.id) return instance.getFinancialInitialStatePresetVersion(input.id, input.includeDeleted);
        }
        if (input.collectionId === "market-makers") {
          if (input.operation === "list") return instance.listMarketMakers(input.includeDeleted);
          if (input.operation === "draft" && input.id) return instance.getMarketMakerDraft(input.id, input.includeDeleted);
          if (input.operation === "version" && input.id) return instance.getMarketMakerVersion(input.id, input.includeDeleted);
        }
        throw new Error(`Unsupported Financial asset read ${input.collectionId}/${input.operation}`);
      }),
      assetCommand: domainProcedure.input(contextAssetCommandSchema.omit({ contextId: true })).mutation(async ({ input }): Promise<unknown> => {
        const instance = await service();
        const payload = input.input as never;
        if (input.collectionId === "financial-presets") {
          if (input.operation === "save") return instance.saveFinancialInitialStatePresetDraft(payload);
          if (input.operation === "publish") return instance.publishFinancialInitialStatePreset(payload);
          if (input.operation === "delete") {
            const deletion = input.input as { target: "draft" | "version"; presetId?: string; versionRef?: string; expectedRevision?: number; idempotencyKey: string };
            return deletion.target === "draft"
              ? instance.deleteFinancialInitialStatePresetDraft({ presetId: deletion.presetId!, expectedRevision: deletion.expectedRevision!, idempotencyKey: deletion.idempotencyKey })
              : instance.deleteFinancialInitialStatePresetVersion({ versionRef: deletion.versionRef!, idempotencyKey: deletion.idempotencyKey });
          }
        }
        if (input.collectionId === "market-makers") {
          if (input.operation === "save") return instance.saveMarketMakerDraft(payload);
          if (input.operation === "validate") return instance.validateMarketMaker(payload);
          if (input.operation === "publish") return instance.publishMarketMaker(payload);
          if (input.operation === "delete") {
            const deletion = input.input as { target: "draft" | "version"; algorithmId?: string; versionRef?: string; expectedRevision?: number; idempotencyKey: string };
            return deletion.target === "draft"
              ? instance.deleteMarketMakerDraft({ algorithmId: deletion.algorithmId!, expectedRevision: deletion.expectedRevision!, idempotencyKey: deletion.idempotencyKey })
              : instance.deleteMarketMakerVersion({ versionRef: deletion.versionRef!, idempotencyKey: deletion.idempotencyKey });
          }
        }
        throw new Error(`Unsupported Financial asset command ${input.collectionId}/${input.operation}`);
      }),
    }),
    financialMarket: createFinancialMarketRouter(provider, revisionProvider),
  });
}

export const financialMarketRouter = createFinancialMarketAppRouter();
export type FinancialMarketRouter = typeof financialMarketRouter;
