import {
  dataDictionarySourceSchema,
  toDataDictionaryJsonSchema,
  type DataDictionarySource,
} from "@openleek/contracts/data-dictionary";
import { socialCommittedFactsSchema } from "@openleek/contracts/observability";

const text = (en: string, zh: string) => ({
  default: en,
  translations: { en, zh },
});

const allowedImports = [
  "math", "statistics", "random", "json", "collections", "itertools",
  "functools", "datetime", "numpy", "networkx", "scipy", "pandas", "sklearn",
];
const limits = { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 };

const participantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slotId", "cohortKey", "cohortIndex", "actorId"],
  properties: {
    slotId: { type: "string", description: "Stable resolved member slot." },
    cohortKey: { type: "string", description: "Population cohort key." },
    cohortIndex: { type: "integer", minimum: 1, description: "One-based position within the cohort." },
    actorId: { type: "string", description: "Canonical Social actor ID assigned by OpenLeek." },
  },
};

const socialSnapshotSchema = {
  type: "object",
  description: "Complete committed Social revision visible to this algorithm.",
  required: ["actors", "posts", "engagements", "relationships", "exposures"],
  properties: {
    actors: { type: "object", additionalProperties: { type: "object" } },
    posts: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["postId", "authorId", "content", "headline", "roundId"],
        properties: {
          postId: { type: "string" },
          authorId: { type: "string" },
          content: { type: "string" },
          headline: { type: "string" },
          roundId: { type: "integer", minimum: 0 },
        },
      },
    },
    engagements: { type: "object", additionalProperties: { type: "object" } },
    relationships: { type: "object", additionalProperties: { type: "object" } },
    exposures: { type: "object", additionalProperties: { type: "object" } },
  },
};

export const socialDataDictionary: DataDictionarySource = dataDictionarySourceSchema.parse({
  schemaVersion: "1",
  ownerId: "social",
  owner: text("Social Environment", "社交环境"),
  revision: "social-domain:2026-07-31",
  entries: [
    {
      schemaVersion: "1",
      id: "social-network",
      ownerId: "social",
      categoryId: "world",
      entryKind: "asset",
      management: { surface: "asset-library", key: "social-network", idField: "networkId", capabilities: ["list", "read", "validate", "save-draft", "publish", "delete-draft", "delete-version"] },
      label: text("Social Network", "社交网络"),
      description: text(
        "A deterministic Python generator that receives resolved Social participants and emits initial directed follow relationships.",
        "接收已解析 Social 参与者并生成初始有向关注关系的确定性 Python 生成器。",
      ),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "Social Network asset",
        additionalProperties: false,
        required: ["name", "source", "defaultConfig", "dependencies", "limits"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 240 },
          source: { type: "string", minLength: 1, maxLength: 250_000 },
          defaultConfig: { type: "object", default: {}, description: "Default value merged into each selected run configuration." },
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
      references: [{ path: "context.population[]", targetEntryId: "population" }],
      examples: [{
        title: text("Empty network", "空网络"),
        value: {
          name: "No follows",
          source: "class NetworkGenerator:\n    CONFIG_SCHEMA = {'type': 'object'}\n    DEFAULT_CONFIG = {}\n    def __init__(self, config, context): self.context = context\n    def generate(self): return {'relationships': []}\n",
          defaultConfig: {},
          dependencies: [],
          limits,
        },
      }],
      programming: {
        language: "python",
        className: "NetworkGenerator",
        constructor: "NetworkGenerator(config, context)",
        methods: [{
          signature: "generate() -> dict",
          description: text("Returns an object with a relationships array.", "返回包含 relationships 数组的对象。"),
        }],
        contextSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          required: ["seed", "population"],
          properties: {
            seed: { type: "string", description: "Deterministic execution seed." },
            population: { type: "array", maxItems: 100_000, items: participantSchema },
          },
        },
        resultSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          required: ["relationships"],
          properties: {
            relationships: {
              type: "array",
              maxItems: 1_000_000,
              description: "No self edges, duplicates or unknown slots.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["followerSlotId", "followeeSlotId"],
                properties: {
                  followerSlotId: { type: "string" },
                  followeeSlotId: { type: "string" },
                },
              },
            },
          },
        },
        allowedImports,
        limits,
        exampleSource: `class NetworkGenerator:
    CONFIG_SCHEMA = {"type": "object"}
    DEFAULT_CONFIG = {}

    def __init__(self, config, context):
        self.population = context["population"]

    def generate(self):
        return {"relationships": []}
`,
      },
    },
    {
      schemaVersion: "1",
      id: "feed-algorithm",
      ownerId: "social",
      categoryId: "world",
      entryKind: "asset",
      management: { surface: "asset-library", key: "feed-algorithm", idField: "algorithmId", capabilities: ["list", "read", "validate", "preview", "save-draft", "publish", "delete-draft", "delete-version"] },
      label: text("Feed Algorithm", "信息流算法"),
      description: text(
        "A Social-owned Python ranking policy. It reads committed history and returns ordered post IDs for each actor.",
        "由 Social 持有的 Python 排序策略。它读取已提交历史，并为每个 actor 返回有序帖子 ID。",
      ),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "Feed Algorithm asset",
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
      references: [],
      examples: [{
        title: text("Empty ranking", "空排序"),
        value: {
          name: "No recommendations",
          source: "class FeedAlgorithm:\n    CONFIG_SCHEMA = {'type': 'object'}\n    DEFAULT_CONFIG = {}\n    def __init__(self, config, context): self.context = context\n    def rank(self, actor_id): return []\n",
          defaultConfig: {},
          dependencies: [],
          limits,
        },
      }],
      programming: {
        language: "python",
        className: "FeedAlgorithm",
        constructor: "FeedAlgorithm(config, context)",
        methods: [{
          signature: "rank(actor_id) -> list[str]",
          description: text(
            "Returns unique post IDs in ranking order, with at most context.feedSize items.",
            "按排序顺序返回唯一帖子 ID，数量不超过 context.feedSize。",
          ),
        }],
        contextSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          required: ["seed", "roundId", "feedSize", "rng_for", "socialHistory"],
          properties: {
            seed: { type: "string" },
            roundId: { type: "integer", minimum: 0 },
            feedSize: { type: "integer", minimum: 1, maximum: 1_000 },
            rng_for: { type: "string", description: "Callable rng_for(actor_id) returning a deterministic random.Random." },
            socialHistory: {
              type: "object",
              description: "Capability-bound reader. all() yields committed records; round(round_id) returns one record.",
              properties: {
                all: { type: "string", description: "all() -> iterator[{roundId, snapshot}]" },
                round: { type: "string", description: "round(round_id) -> {roundId, snapshot}" },
                record: socialSnapshotSchema,
              },
            },
          },
        },
        resultSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "array",
          maxItems: 1_000,
          uniqueItems: true,
          items: { type: "string", description: "Post ID." },
        },
        allowedImports,
        limits,
        exampleSource: `class FeedAlgorithm:
    CONFIG_SCHEMA = {"type": "object"}
    DEFAULT_CONFIG = {}

    def __init__(self, config, context):
        self.history = context["socialHistory"]

    def rank(self, actor_id):
        return []
`,
      },
    },
    {
      schemaVersion: "1",
      id: "social-committed-facts",
      ownerId: "social",
      categoryId: "experiment",
      entryKind: "evidence",
      management: { surface: "run", key: "social-committed-facts", idField: "revisionRef", capabilities: ["read"] },
      label: text("Social committed facts", "社交已提交事实"),
      description: text("Posts, exposures, engagements, relationships and summary from one committed Social revision.", "一个已提交 Social Revision 中的帖子、曝光、互动、关系与汇总。"),
      definitionSchema: toDataDictionaryJsonSchema(socialCommittedFactsSchema),
      references: [],
      examples: [],
    },
    {
      schemaVersion: "1",
      id: "social-observer-public",
      ownerId: "social",
      categoryId: "experiment",
      entryKind: "projection",
      management: { surface: "run", key: "social-observer-public", idField: "revisionRef", capabilities: ["read"] },
      label: text("Social observer public client", "社交观察者公共客户端"),
      description: text("Public timeline, post, profile and relationship views for one committed Social revision without exposures or notifications.", "一个已提交 Social Revision 的公共时间线、帖子、资料与关系视图，不包含曝光或通知。"),
      definitionSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["runId", "revisionRef"],
        properties: {
          runId: { type: "string" },
          revisionRef: { type: "string" },
          view: { type: "string", enum: ["timeline", "post", "profile", "relationships"] },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      references: [],
      examples: [],
    },
  ],
});
