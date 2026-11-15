import { createHash, randomUUID } from "node:crypto";
import { dynamicContextRevisionSchema, type DynamicContextRevision } from "@openleek/contracts/context";
import { identifierSchema } from "@openleek/contracts/core";
import { z } from "zod";

export const newsArticleSchema = z.object({
  articleId: identifierSchema,
  headline: z.string().min(1).max(500),
  body: z.string().min(1).max(50_000),
  source: z.string().min(1).max(240).optional(),
  publishedAt: z.string().datetime({ offset: true }),
}).strict();
export const newsScenarioDefinitionSchema = z.object({
  schemaVersion: z.literal("2"),
  articles: z.array(newsArticleSchema).max(10_000),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.articles.forEach((article, index) => {
    if (ids.has(article.articleId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate articleId", path: ["articles", index, "articleId"] });
    ids.add(article.articleId);
  });
});
export type NewsScenarioDefinition = z.infer<typeof newsScenarioDefinitionSchema>;
export interface NewsScenarioDraft { scenarioId: string; name: string; definition: NewsScenarioDefinition; revision: number; updatedAt: string }
export interface NewsScenarioVersion { scenarioId: string; versionRef: string; name: string; definition: NewsScenarioDefinition; artifactDigest: string; publishedAt: string; draftRevision: number }
export interface NewsScenarioTombstone { target: "draft" | "version"; assetId: string; idempotencyKey: string; deletedAt: string }
export interface NewsClock { startUnixSeconds: number; stepSeconds: number }
export interface NewsRunConfiguration { runId: string; scenarioVersionRef: string; clock: NewsClock }
export interface NewsRevision extends DynamicContextRevision { scenarioVersionRef: string; simulationTime: string; committed: boolean }
export function projectNewsRevision(revision: NewsRevision): DynamicContextRevision {
  return { ref: revision.ref, context: revision.context, runId: revision.runId, roundId: revision.roundId, digest: revision.digest, ...(revision.parentRevisionRef ? { parentRevisionRef: revision.parentRevisionRef } : {}) };
}
export interface NewsBinding { runId: string; agentId: string; principalId: string; tokenDigest: string; tools: readonly string[]; resources: readonly string[]; revoked: boolean }
export interface NewsScope { scopeId: string; runId: string; roundId: number; agentId: string; principalId: string; revisionRef: string; turnId: string; attemptId: string; expiresAt: string }
export function projectNewsScope(scope: NewsScope) { return { scopeId: scope.scopeId, runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, principalId: scope.principalId, turnId: scope.turnId, attemptId: scope.attemptId, expiresAt: scope.expiresAt }; }

export interface NewsStore {
  saveDraft(value: NewsScenarioDraft): Promise<void>; draft(id: string): Promise<NewsScenarioDraft | undefined>; listDrafts(): Promise<NewsScenarioDraft[]>;
  saveScenario(value: NewsScenarioVersion): Promise<void>; scenario(ref: string): Promise<NewsScenarioVersion | undefined>; listScenarios(): Promise<NewsScenarioVersion[]>;
  saveTombstone(value: NewsScenarioTombstone): Promise<void>; tombstone(target: "draft" | "version", id: string): Promise<NewsScenarioTombstone | undefined>; listTombstones(): Promise<NewsScenarioTombstone[]>;
  saveRun(value: NewsRunConfiguration): Promise<void>; run(runId: string): Promise<NewsRunConfiguration | undefined>;
  saveRevision(value: NewsRevision): Promise<void>; revision(ref: string): Promise<NewsRevision | undefined>;
  saveBinding(value: NewsBinding): Promise<void>; binding(tokenDigest: string): Promise<NewsBinding | undefined>; bindingsForRun(runId: string): Promise<NewsBinding[]>;
  saveScope(value: NewsScope): Promise<void>; scope(runId: string, agentId: string): Promise<NewsScope | undefined>; deleteScope(runId: string, agentId: string, scopeId?: string): Promise<void>;
}

export class NewsContextService {
  constructor(private readonly store: NewsStore) {}

  async listScenarios(includeDeleted = false) {
    const [drafts, versions, tombstones] = await Promise.all([this.store.listDrafts(), this.store.listScenarios(), this.store.listTombstones()]);
    if (includeDeleted) return { drafts, versions, tombstones };
    const deleted = new Set(tombstones.map((item) => `${item.target}:${item.assetId}`));
    return { drafts: drafts.filter((item) => !deleted.has(`draft:${item.scenarioId}`)), versions: versions.filter((item) => !deleted.has(`version:${item.versionRef}`)) };
  }
  async draft(scenarioId: string, includeDeleted = false) { const value = await this.store.draft(identifierSchema.parse(scenarioId)); if (!value || (!includeDeleted && await this.store.tombstone("draft", scenarioId))) throw new Error("News Scenario draft was not found"); return value; }
  async scenario(versionRef: string, includeDeleted = false) { const value = await this.store.scenario(identifierSchema.parse(versionRef)); if (!value || (!includeDeleted && await this.store.tombstone("version", versionRef))) throw new Error("News Scenario version was not found"); return value; }
  validateScenario(definition: unknown) { return { valid: true, definition: normalizeDefinition(definition), errors: [] as string[] }; }
  async saveDraft(input: { scenarioId?: string; expectedRevision?: number; name: string; definition: unknown }) {
    const definition = normalizeDefinition(input.definition); const scenarioId = input.scenarioId ? identifierSchema.parse(input.scenarioId) : `news-scenario:${randomUUID()}`;
    if (await this.store.tombstone("draft", scenarioId)) throw new Error("deleted News Scenario draft IDs cannot be reused");
    const existing = await this.store.draft(scenarioId);
    if (existing && existing.revision !== input.expectedRevision) throw new Error("News Scenario draft has changed; reload before saving");
    if (!existing && input.expectedRevision !== undefined) throw new Error("News Scenario draft was not found");
    const draft: NewsScenarioDraft = { scenarioId, name: input.name.trim(), definition, revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    if (!draft.name) throw new Error("name must not be empty"); await this.store.saveDraft(draft); return draft;
  }
  async publishDraft(input: { scenarioId: string; expectedRevision: number }) { const draft = await this.draft(input.scenarioId); if (draft.revision !== input.expectedRevision) throw new Error("News Scenario draft has changed; reload before publishing"); return this.publishScenario({ scenarioId: draft.scenarioId, name: draft.name, definition: draft.definition, draftRevision: draft.revision }); }
  async publishScenario(input: { scenarioId?: string; name: string; definition: unknown; draftRevision?: number }) {
    const definition = normalizeDefinition(input.definition); const scenarioId = input.scenarioId ?? `news-scenario:${randomUUID()}`; const artifactDigest = digest(definition);
    const existing = (await this.store.listScenarios()).find((item) => item.scenarioId === scenarioId && item.artifactDigest === artifactDigest); if (existing) return existing;
    const value: NewsScenarioVersion = { scenarioId, versionRef: `${scenarioId}:v:${artifactDigest.slice(0, 16)}`, name: input.name.trim(), definition, artifactDigest, publishedAt: new Date().toISOString(), draftRevision: input.draftRevision ?? 0 };
    if (!value.name) throw new Error("name must not be empty"); await this.store.saveScenario(value); return value;
  }
  async deleteScenario(input: { target: "draft" | "version"; assetId: string; idempotencyKey: string; expectedRevision?: number }) {
    const existing = await this.store.tombstone(input.target, input.assetId); if (existing) return { status: "already-deleted", replayed: existing.idempotencyKey === input.idempotencyKey, tombstone: existing };
    if (input.target === "draft") { const draft = await this.draft(input.assetId, true); if (draft.revision !== input.expectedRevision) throw new Error("News Scenario draft has changed; reload before deleting"); } else await this.scenario(input.assetId, true);
    const tombstone: NewsScenarioTombstone = { target: input.target, assetId: input.assetId, idempotencyKey: input.idempotencyKey, deletedAt: new Date().toISOString() }; await this.store.saveTombstone(tombstone); return { status: "deleted", replayed: false, tombstone };
  }

  async validateRuntimeScenario(versionRef: string) { const scenario = await this.scenario(versionRef); return newsScenarioDefinitionSchema.parse(scenario.definition); }
  async initialize(input: { runId: string; scenarioVersionRef: string; clock: NewsClock }) {
    await this.validateRuntimeScenario(input.scenarioVersionRef); const run = { runId: input.runId, scenarioVersionRef: input.scenarioVersionRef, clock: clockSchema.parse(input.clock) };
    const existing = await this.store.run(input.runId); if (existing && canonical(existing) !== canonical(run)) throw new Error("News Run configuration is immutable"); if (!existing) await this.store.saveRun(run);
    const baseline = await this.makeRevision(input.runId, 0, input.scenarioVersionRef, simulationTime(run.clock, 1));
    return this.commit(baseline.ref);
  }
  async freeze(input: { runId: string; roundId: number; baselineRef: string }) {
    const baseline = await this.requiredRevision(input.baselineRef); if (baseline.runId !== input.runId) throw new Error("baseline belongs to a different Run"); if (input.roundId !== baseline.roundId + 1) throw new Error("News rounds must advance sequentially");
    const run = await this.requiredRun(input.runId); return this.makeRevision(input.runId, input.roundId, baseline.scenarioVersionRef, simulationTime(run.clock, input.roundId), baseline.ref);
  }
  async fork(input: { sourceRevisionRef: string; targetRunId: string; targetClock: NewsClock }) {
    const source = await this.requiredRevision(input.sourceRevisionRef); if (!source.committed) throw new Error("News fork requires a committed source revision");
    const run = { runId: input.targetRunId, scenarioVersionRef: source.scenarioVersionRef, clock: clockSchema.parse(input.targetClock) }; const existing = await this.store.run(input.targetRunId); if (existing && canonical(existing) !== canonical(run)) throw new Error("News Run configuration is immutable"); if (!existing) await this.store.saveRun(run);
    const forked = await this.makeRevision(input.targetRunId, source.roundId, source.scenarioVersionRef, simulationTime(run.clock, Math.max(1, source.roundId)), source.ref); return this.commit(forked.ref);
  }
  async commit(ref: string) { const revision = await this.requiredRevision(ref); const committed = { ...revision, committed: true }; await this.store.saveRevision(committed); return committed; }
  async bind(input: { runId: string; agents: readonly { agentId: string; principalId: string; bearerToken: string; tools: readonly string[]; resources: readonly string[] }[] }) {
    return Promise.all(input.agents.map(async (agent) => { const value: NewsBinding = { runId: input.runId, agentId: agent.agentId, principalId: agent.principalId, tokenDigest: digestToken(agent.bearerToken), tools: [], resources: agent.resources.filter((resource) => resource === "news.daily"), revoked: false }; await this.store.saveBinding(value); return { context: "news" as const, agentId: agent.agentId, endpoint: process.env.OPENLEEK_NEWS_CONTEXT_MCP_URL ?? "http://news-context:3000/internal/mcp" }; }));
  }
  async openScope(input: Omit<NewsScope, "scopeId" | "expiresAt">) { const revision = await this.requiredRevision(input.revisionRef); if (revision.runId !== input.runId || revision.roundId !== input.roundId) throw new Error("scope must pin this round's frozen revision from this Run"); const bindings = await this.store.bindingsForRun(input.runId); if (!bindings.some((item) => item.agentId === input.agentId && item.principalId === input.principalId && !item.revoked)) throw new Error("News binding is not active"); const scope: NewsScope = { ...input, scopeId: `news-scope:${randomUUID()}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }; await this.store.saveScope(scope); return scope; }
  async closeScope(input: { runId: string; agentId: string; scopeId: string }) { await this.store.deleteScope(input.runId, input.agentId, input.scopeId); }
  async revokeRun(runId: string) { const bindings = await this.store.bindingsForRun(runId); await Promise.all(bindings.map(async (binding) => { await this.store.saveBinding({ ...binding, revoked: true }); await this.store.deleteScope(runId, binding.agentId); })); }

  async listDailyResources(token: string, cursor?: string) {
    const { revisionRef } = await this.authorizeDaily(token); const { revision, scenario } = await this.view(revisionRef); const dates = [...new Set(visibleArticles(revision, scenario).map((article) => article.publishedAt.slice(0, 10)))].sort((a, b) => b.localeCompare(a));
    const offset = decodeCursor(cursor); const page = dates.slice(offset, offset + 100); return { resources: page.map((date) => ({ uri: dailyUri(revision.ref, date), name: `News ${date}`, description: `Full researcher-authored news published on ${date} UTC.`, mimeType: "application/json" })), ...(offset + page.length < dates.length ? { nextCursor: encodeCursor(offset + page.length) } : {}) };
  }
  async readDailyResource(token: string, uri: string) {
    const { revisionRef } = await this.authorizeDaily(token); const parsed = parseDailyUri(uri); if (parsed.revisionRef !== revisionRef) throw new Error("News resource is not part of the active revision");
    const { revision, scenario } = await this.view(revisionRef); return { schemaVersion: "1", date: parsed.date, simulationTime: revision.simulationTime, articles: visibleArticles(revision, scenario).filter((article) => article.publishedAt.slice(0, 10) === parsed.date) };
  }
  private async authorizeDaily(token: string) { const binding = await this.store.binding(digestToken(token)); if (!binding || binding.revoked) throw new Error("News credential is invalid or revoked"); const scope = await this.store.scope(binding.runId, binding.agentId); if (!scope || scope.principalId !== binding.principalId || Date.parse(scope.expiresAt) <= Date.now()) throw new Error("News scope is not active"); if (!binding.resources.includes("news.daily")) throw new Error("News daily resource is not granted"); return { revisionRef: scope.revisionRef, binding }; }
  private async view(ref: string) { const revision = await this.requiredRevision(ref); const scenario = await this.scenario(revision.scenarioVersionRef); newsScenarioDefinitionSchema.parse(scenario.definition); return { revision, scenario }; }
  private async makeRevision(runId: string, roundId: number, scenarioVersionRef: string, simulationTimeValue: string, parentRevisionRef?: string) { const body = { context: "news", runId, roundId, scenarioVersionRef, simulationTime: simulationTimeValue, ...(parentRevisionRef ? { parentRevisionRef } : {}) }; const revision: NewsRevision = { ref: `news-revision:${digest(body)}`, digest: digest(body), ...body, committed: false }; dynamicContextRevisionSchema.parse(projectNewsRevision(revision)); await this.store.saveRevision(revision); return revision; }
  private async requiredRevision(ref: string) { const value = await this.store.revision(ref); if (!value) throw new Error(`unknown News revision '${ref}'`); return value; }
  private async requiredRun(runId: string) { const value = await this.store.run(runId); if (!value) throw new Error(`unknown News Run '${runId}'`); return value; }
}

const clockSchema = z.object({ startUnixSeconds: z.number().int(), stepSeconds: z.number().int().positive() }).strict();
function normalizeDefinition(value: unknown): NewsScenarioDefinition { const parsed = newsScenarioDefinitionSchema.parse(value); return { ...parsed, articles: parsed.articles.map((article) => ({ ...article, publishedAt: new Date(article.publishedAt).toISOString() })) }; }
function visibleArticles(revision: NewsRevision, scenario: NewsScenarioVersion) { const cutoff = Date.parse(revision.simulationTime); return scenario.definition.articles.filter((article) => Date.parse(article.publishedAt) <= cutoff).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.articleId.localeCompare(b.articleId)); }
function simulationTime(clock: NewsClock, roundId: number) { return new Date((clock.startUnixSeconds + (roundId - 1) * clock.stepSeconds) * 1000).toISOString(); }
function dailyUri(revisionRef: string, date: string) { return `news://revision/${encodeURIComponent(revisionRef)}/days/${date}`; }
function parseDailyUri(uri: string) { const match = /^news:\/\/revision\/([^/]+)\/days\/(\d{4}-\d{2}-\d{2})$/.exec(uri); if (!match) throw new Error("invalid News daily resource URI"); return { revisionRef: decodeURIComponent(match[1]!), date: match[2]! }; }
function encodeCursor(offset: number) { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeCursor(cursor?: string) { if (!cursor) return 0; try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown }; if (!Number.isInteger(value.offset) || Number(value.offset) < 0) throw new Error(); return Number(value.offset); } catch { throw new Error("invalid News resource cursor"); } }
function digestToken(value: string) { return createHash("sha256").update(value).digest("hex"); }
function digest(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }

export class MemoryNewsStore implements NewsStore {
  drafts = new Map<string, NewsScenarioDraft>(); scenarios = new Map<string, NewsScenarioVersion>(); tombstones = new Map<string, NewsScenarioTombstone>(); runs = new Map<string, NewsRunConfiguration>(); revisions = new Map<string, NewsRevision>(); bindings = new Map<string, NewsBinding>(); scopes = new Map<string, NewsScope>();
  async saveDraft(value: NewsScenarioDraft) { this.drafts.set(value.scenarioId, structuredClone(value)); } async draft(id: string) { return this.drafts.get(id); } async listDrafts() { return [...this.drafts.values()].map((item) => structuredClone(item)); }
  async saveScenario(value: NewsScenarioVersion) { if (!this.scenarios.has(value.versionRef)) this.scenarios.set(value.versionRef, structuredClone(value)); } async scenario(ref: string) { return this.scenarios.get(ref); } async listScenarios() { return [...this.scenarios.values()].map((item) => structuredClone(item)); }
  async saveTombstone(value: NewsScenarioTombstone) { this.tombstones.set(`${value.target}:${value.assetId}`, structuredClone(value)); } async tombstone(target: "draft" | "version", id: string) { return this.tombstones.get(`${target}:${id}`); } async listTombstones() { return [...this.tombstones.values()].map((item) => structuredClone(item)); }
  async saveRun(value: NewsRunConfiguration) { this.runs.set(value.runId, structuredClone(value)); } async run(runId: string) { return this.runs.get(runId); }
  async saveRevision(value: NewsRevision) { this.revisions.set(value.ref, structuredClone(value)); } async revision(ref: string) { return this.revisions.get(ref); }
  async saveBinding(value: NewsBinding) { this.bindings.set(value.tokenDigest, structuredClone(value)); } async binding(tokenDigest: string) { return this.bindings.get(tokenDigest); } async bindingsForRun(runId: string) { return [...this.bindings.values()].filter((item) => item.runId === runId); }
  async saveScope(value: NewsScope) { this.scopes.set(`${value.runId}:${value.agentId}`, structuredClone(value)); } async scope(runId: string, agentId: string) { return this.scopes.get(`${runId}:${agentId}`); } async deleteScope(runId: string, agentId: string, scopeId?: string) { const key = `${runId}:${agentId}`; const existing = this.scopes.get(key); if (!scopeId || existing?.scopeId === scopeId) this.scopes.delete(key); }
}
