import { contextAssetCommandSchema, contextAssetReadSchema, contextPluginDescriptorSchema } from "@openleek/contracts/context";
import { identifierSchema } from "@openleek/contracts/core";
import { domainProcedure, t } from "@openleek/trpc";
import { z } from "zod";
import { newsContext } from "./runtime";
import { newsUiModuleSha256 } from "./ui-module";

export const newsDescriptor = contextPluginDescriptorSchema.parse({
  schemaVersion: "3", runtimeProtocol: "openleek-context-runtime/v2", contextId: "news", revision: "news-context:v4", infrastructure: { postgres: true, redis: false }, agentAccess: "read-only", observerViews: [], uiModule: { apiVersion: "openleek-context-ui/v1", path: "/api/context/v2/ui", sha256: newsUiModuleSha256, elements: { configuration: "openleek-news-configuration", assets: "openleek-news-assets", observer: "openleek-news-observer", facts: "openleek-news-facts" } },
  label: { default: "News Context", translations: { en: "News Context", zh: "新闻环境" } }, description: { default: "Researcher-authored news exposed as immutable daily resources on the simulation clock.", translations: { zh: "由研究者预先编写、按模拟时钟以每日只读资源发布的新闻环境。" } },
  agentEnvironment: { accountPolicySchema: { type: "object", additionalProperties: false }, accountPolicyUiSchema: {}, capabilities: [
    { id: "news.daily", kind: "resource", label: { default: "Daily news", translations: { zh: "每日新闻" } } },
  ] },
  worldEnvironment: { collections: [{
    id: "news-scenarios",
    label: { default: "News Scenarios", translations: { zh: "新闻场景" } },
    description: { default: "Immutable UTC publication timeline.", translations: {} },
    definitionSchema: {
      type: "object",
      properties: { schemaVersion: { const: "2" }, articles: { type: "array", items: {
        type: "object",
        properties: { articleId: { type: "string" }, headline: { type: "string" }, body: { type: "string" }, source: { type: "string" }, publishedAt: { type: "string", format: "date-time" } },
        required: ["articleId", "headline", "body", "publishedAt"],
        additionalProperties: false,
      } } },
      required: ["schemaVersion", "articles"],
      additionalProperties: false,
    },
    uiSchema: {},
    actions: ["list", "draft", "save", "validate", "publish", "delete"],
  }] },
  experimentConfigurationSchema: { type: "object", properties: { scenarioVersionRef: { type: "string" } }, required: ["scenarioVersionRef"], additionalProperties: false }, experimentConfigurationUiSchema: {},
});

const collection = "news-scenarios";
export const newsRouter = t.router({ contextPlugin: t.router({
  descriptor: domainProcedure.input(z.object({}).strict()).output(contextPluginDescriptorSchema).query(() => newsDescriptor),
  assetRead: domainProcedure.input(contextAssetReadSchema.omit({ contextId: true })).query(async ({ input }) => {
    if (input.collectionId !== collection) throw new Error("unknown News collection");
    const service = await newsContext();
    if (input.operation === "list") return service.listScenarios(input.includeDeleted);
    if (!input.id) throw new Error("id is required");
    return input.operation === "draft" ? service.draft(input.id, input.includeDeleted) : service.scenario(input.id, input.includeDeleted);
  }),
  assetCommand: domainProcedure.input(contextAssetCommandSchema.omit({ contextId: true })).mutation(async ({ input }) => {
    if (input.collectionId !== collection) throw new Error("unknown News collection");
    const service = await newsContext(); const value = input.input as Record<string, unknown>;
    if (input.operation === "validate") return service.validateScenario(value.definition ?? value);
    if (input.operation === "save") return service.saveDraft(value as never);
    if (input.operation === "publish") return service.publishDraft({ scenarioId: identifierSchema.parse(value.scenarioId), expectedRevision: z.number().int().positive().parse(value.expectedRevision) });
    if (input.operation === "delete") return service.deleteScenario(newsDeletionInput(value));
    throw new Error("News Scenario preview is not supported");
  }),
}) });
export type NewsRouter = typeof newsRouter;

export function newsDeletionInput(value: Record<string, unknown>) {
  const target = z.enum(["draft", "version"]).parse(value.target);
  const assetId = identifierSchema.parse(value.assetId ?? (target === "draft" ? value.scenarioId ?? value.algorithmId : value.versionRef));
  return { target, assetId, idempotencyKey: identifierSchema.parse(value.idempotencyKey), ...(target === "draft" ? { expectedRevision: z.number().int().positive().parse(value.expectedRevision) } : {}) };
}
