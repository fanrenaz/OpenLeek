import { randomUUID } from "node:crypto";
import { financialMcpPermissionsSchema, type FinancialMcpPermissions } from "@openleek/contracts/agent";
import { invalid, notFound, precondition } from "../domain/errors";
import { cashToUnits, decimalDelta, priceToUnits, tickSizeFor, unitsForSnapshot, unitsToDecimal } from "../domain/price-units";
import type { MarketAction, MarketMakerOrderIntent, MarketMakerSelection, MarketMakerTiming, MarketSummary, Order, Trade } from "../domain/models";
import { sha256 } from "./canonical";
import { clone } from "./idempotency";
import type { MaterialMarketState } from "./persistence";
import type {
  FinancialContextRevision,
  FinancialIntentRecord,
  FinancialMarketMakerExecution,
  FinancialMcpAgent,
  FinancialMcpBinding,
  FinancialMcpPrincipalRegistration,
  FinancialMcpResource,
  FinancialMcpScope,
  FinancialOutboxRecord,
  FinancialRevisionSnapshot,
  FinancialRoundSettlement,
  FinancialRoundWorkspace,
  StoredFinancialRevision,
} from "./revision-model";
import {
  emptyFinancialRevisionState,
  type FinancialRevisionRunState,
  type FinancialRevisionState,
  type FinancialRevisionStore,
} from "./revision-store";
import { FinancialMarketService } from "./financial-market-service";

type FinancialMcpResourceId = FinancialMcpPermissions["resources"][number];
type FinancialMcpToolId = FinancialMcpPermissions["tools"][number];
const FINANCIAL_RESOURCE_PAGE_SIZE = 25;
const EXECUTION_DEFAULT_LIMIT = 10;
const MARKET_READ_TOOLS = new Set<FinancialMcpToolId>([
  "financial.get_quote",
  "financial.get_order_book",
  "financial.get_candles",
  "financial.list_market_trades",
  "financial.list_market_orders",
]);

function financialMcpActionId(scope: FinancialMcpScope, tool: string, invocationId: string): string {
  requireText(invocationId, "invocationId");
  return `mcp:financial:${sha256({
    runId: scope.runId,
    roundId: scope.roundId,
    agentId: scope.agentId,
    turnId: scope.turnId,
    tool,
    invocationId,
  })}`;
}

export interface FinancialRevisionServiceOptions {
  market: FinancialMarketService;
  store: FinancialRevisionStore;
  credentialVerifier?: FinancialMcpCredentialVerifier;
  now?: () => Date;
  endpoint?: string;
  marketMakerHistoryEndpoint?: string;
}

/** The Context validates Experiment-issued bearer JWS claims through this port. */
export interface FinancialMcpCredentialVerifier {
  verifyBearer(token: string): Promise<FinancialMcpCredentialClaims>;
}

export interface FinancialMcpCredentialClaims {
  principalId: string;
  runId: string;
  agentId: string;
  audience: string;
  credentialVersion: number;
  issuedAt: number;
}

export interface FreezeFinancialRevisionInput {
  runId: string;
  roundId: number;
  baseline: FinancialContextRevision;
  sourceManifestRef?: string;
}

export interface OpenFinancialWorktreeInput {
  runId: string;
  roundId: number;
  baseRevision: FinancialContextRevision;
  readRevision: FinancialContextRevision;
}

export interface EnqueueFinancialIntentInput {
  runId: string;
  roundId: number;
  agentId: string;
  accountId: string;
  turnId: string;
  attemptId?: string;
  action: MarketAction;
  rationale?: string;
}

export interface FinancialOutboxPublisher {
  publish(record: FinancialOutboxRecord): Promise<string>;
}

export interface FinancialMcpRead {
  mimeType: "application/json";
  text: string;
}

/**
 * Owns Financial's revision object graph and the private worktree used to
 * derive candidate revisions.  The live legacy market service remains intact
 * for the current tRPC contract; this service is the copy-on-write path used
 * by the Context-owned MCP and the next Experiment protocol.
 */
export class FinancialRevisionService {
  private state: FinancialRevisionState;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly transientMarketMakerSnapshots = new Map<string, { roundId: number; snapshot: FinancialRevisionSnapshot }>();

  private constructor(
    private readonly market: FinancialMarketService,
    private readonly store: FinancialRevisionStore,
    private readonly credentialVerifier: FinancialMcpCredentialVerifier,
    private readonly now: () => Date,
    private readonly endpoint: string,
    private readonly marketMakerHistoryEndpoint: string,
    state: FinancialRevisionState,
  ) {
    this.state = state;
  }

  static async create(options: FinancialRevisionServiceOptions): Promise<FinancialRevisionService> {
    const state = (await options.store.load()) ?? emptyFinancialRevisionState();
    validateState(state);
    markLegacyMcpPrincipals(state);
    const service = new FinancialRevisionService(
      options.market,
      options.store,
      options.credentialVerifier ?? unavailableCredentialVerifier,
      options.now ?? (() => new Date()),
      options.endpoint ?? process.env.OPENLEEK_FINANCIAL_MCP_URL ?? "http://127.0.0.1:3107/internal/mcp",
      options.marketMakerHistoryEndpoint ?? process.env.OPENLEEK_FINANCIAL_MARKET_MAKER_HISTORY_URL ?? "http://financial-market:3000/internal/market-maker/history",
      state,
    );
    return service;
  }

  /** Creates the round-zero immutable object after the legacy market init. */
  async initializeRevision(input: {
    runId: string;
    checkpointRef: string;
    sourceManifestRef?: string;
  }): Promise<FinancialContextRevision> {
    return this.mutate(async () => {
      const run = this.run(input.runId);
      const snapshot = this.market.getFullSnapshot(input.runId, input.checkpointRef);
      const revision = makeRevision({
        runId: input.runId,
        roundId: snapshot.publishedRound,
        kind: "initial",
        snapshot,
        ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        now: this.now(),
      });
      const existing = run.revisions[revision.ref];
      if (existing !== undefined) return publicRevision(existing);
      run.revisions[revision.ref] = revision;
      run.revisionHeadRef ??= revision.ref;
      return publicRevision(revision);
    }, true);
  }

  /**
   * Pins the Agent-visible read revision. Opening Market Maker quotes are
   * already materialized here; its history reader still sees only the parent
   * committed lineage, never this new worktree.
   */
  async freezeFullSnapshot(input: FreezeFinancialRevisionInput): Promise<FinancialContextRevision> {
    return this.mutate(async () => {
      requireRound(input.roundId);
      if (input.baseline.runId !== input.runId || input.baseline.context !== "financial_market") {
        throw precondition("Financial read revision must use this run's Financial baseline");
      }
      const run = this.run(input.runId);
      const baseline = requireRevision(run, input.baseline.ref);
      const key = String(input.roundId);
      let worktree = run.roundWorkspaces[key];
      if (worktree === undefined) {
        // This private placeholder is never persisted: it is replaced by the
        // final deterministic read revision before this mutation completes.
        worktree = {
          roundId: input.roundId,
          baseRevisionRef: baseline.ref,
          readRevisionRef: "pending",
          intents: {},
          outbox: {},
          marketMakerExecutions: {},
          closed: false,
        };
        run.roundWorkspaces[key] = worktree;
      } else if (worktree.baseRevisionRef !== baseline.ref) {
        throw precondition("Financial worktree already exists with a different base revision");
      }
      if (worktree.readRevisionRef !== "pending") {
        return publicRevision(requireRevision(run, worktree.readRevisionRef));
      }
      await this.ensureMarketMakerExecution(input.runId, input.roundId, worktree, "opening");
      const snapshot = this.materialize(input.runId, input.roundId, worktree, [], false);
      const revision = makeRevision({
        runId: input.runId,
        roundId: input.roundId,
        kind: "read_snapshot",
        parentRevisionRef: baseline.ref,
        snapshot,
        ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        now: this.now(),
      });
      run.revisions[revision.ref] ??= revision;
      worktree.readRevisionRef = revision.ref;
      worktree.provisionalSnapshot = clone(snapshot);
      return publicRevision(run.revisions[revision.ref]!);
    });
  }

  async openWorktree(input: OpenFinancialWorktreeInput): Promise<void> {
    await this.mutate(async () => {
      requireRound(input.roundId);
      const run = this.run(input.runId);
      const base = requireRevision(run, input.baseRevision.ref);
      const read = requireRevision(run, input.readRevision.ref);
      if (base.runId !== input.runId || read.runId !== input.runId || read.roundId !== input.roundId) {
        throw precondition("Financial worktree revisions do not describe this round");
      }
      const key = String(input.roundId);
      const existing = run.roundWorkspaces[key];
      if (existing !== undefined) {
        if (existing.baseRevisionRef !== base.ref || existing.readRevisionRef !== read.ref) {
          throw precondition("Financial worktree already exists with a different revision pair");
        }
        return;
      }
      run.roundWorkspaces[key] = {
        roundId: input.roundId,
        baseRevisionRef: base.ref,
        readRevisionRef: read.ref,
        intents: {},
        outbox: {},
        marketMakerExecutions: {},
        closed: false,
      };
    });
  }

  async enqueueIntent(input: EnqueueFinancialIntentInput): Promise<FinancialIntentRecord> {
    return this.mutate(async () => {
      requireText(input.agentId, "agentId");
      requireText(input.accountId, "accountId");
      requireText(input.turnId, "turnId");
      const run = this.run(input.runId);
      const worktree = requireWorktree(run, input.roundId);
      if (worktree.closed) throw precondition("Financial round is closed to new trade intents");
      if (input.action.accountId !== input.accountId) {
        throw precondition("Financial MCP principal may only trade its bound account");
      }
      const actionId = input.action.actionId;
      requireText(actionId, "actionId");
      if (input.action.type === "submitOrder" || input.action.type === "replaceOrder") {
        requireSafePositiveInteger(input.action.quantity, "quantity");
        requireSafePositiveInteger(input.action.limitPrice, "limitPrice");
      } else if (input.action.type === "submitMarketOrder") {
        requireSafePositiveInteger(input.action.quantity, "quantity");
      }
      const commandId = `financial-intent:${sha256({ runId: input.runId, roundId: input.roundId, agentId: input.agentId, turnId: input.turnId, actionId })}`;
      const existing = worktree.intents[commandId];
      if (existing !== undefined) {
        if (sha256(existing.action) !== sha256(input.action)) {
          throw invalid("same Financial action identity has a different payload", "actionId");
        }
        return clone(existing);
      }
      const sameAction = Object.values(worktree.intents).find((intent) => intent.actionId === actionId);
      if (sameAction !== undefined) {
        if (sha256(sameAction.action) !== sha256(input.action)) {
          throw invalid("Financial actionId must be unique in a round worktree", "actionId");
        }
        return clone(sameAction);
      }
      const account = requireRevision(run, worktree.readRevisionRef).snapshot.accounts.find((candidate) => candidate.accountId === input.accountId);
      if (!account) throw precondition("Financial account does not exist");
      const used = Object.values(worktree.intents).filter((intent) => intent.accountId === input.accountId).length;
      if (used >= account.maximumActionsPerRound) {
        throw precondition(`Financial account action limit reached (${account.maximumActionsPerRound} per round)`);
      }
      const createdAt = this.now().toISOString();
      const intent: FinancialIntentRecord = {
        commandId,
        action: clone(input.action),
        roundId: input.roundId,
        accountId: input.accountId,
        agentId: input.agentId,
        turnId: input.turnId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        actionId,
        status: "pending",
        ...(input.rationale === undefined ? {} : { rationale: input.rationale.slice(0, 2_000) }),
        createdAt,
      };
      // Intent and outbox are committed together. The dedicated publisher may
      // retry Redis independently without losing the accepted command.
      worktree.intents[commandId] = intent;
      worktree.outbox[commandId] = {
        commandId,
        streamKey: `financial-market:${input.runId}:${input.roundId}`,
        payload: { runId: input.runId, roundId: input.roundId, commandId },
        status: "pending",
        createdAt,
      };
      return clone(intent);
    }, true);
  }

  async publishPendingOutbox(
    runId: string,
    roundId: number,
    publisher: FinancialOutboxPublisher,
  ): Promise<number> {
    const records = this.outboxRecords(runId, roundId).filter((record) => record.status === "pending");
    for (const record of records) {
      const streamId = await publisher.publish(clone(record));
      await this.recordOutboxPublished(runId, roundId, record.commandId, streamId);
    }
    return records.length;
  }

  /**
   * Read-only owner status for Experiment. Failed provider turns are ignored
   * because candidate sealing excludes them; every remaining pending command
   * must be drained by Financial's Redis worker before a revision can seal.
   */
  async settlementStatus(input: { runId: string; roundId: number; finalFailedTurnIds: readonly string[] }): Promise<FinancialRoundSettlement> {
    await this.refreshFromStore();
    const worktree = requireWorktree(this.run(input.runId), input.roundId);
    const excluded = new Set(input.finalFailedTurnIds);
    const pendingIntents = orderedIntents(worktree)
      .filter((intent) => intent.status === "pending" && !excluded.has(intent.turnId));
    const pendingOutboxCount = Object.values(worktree.outbox)
      .filter((outbox) => {
        const intent = worktree.intents[outbox.commandId];
        return intent !== undefined
          && intent.status === "pending"
          && !excluded.has(intent.turnId)
          && outbox.status !== "applied";
      }).length;
    return {
      settled: pendingIntents.length === 0 && pendingOutboxCount === 0,
      pendingIntentCount: pendingIntents.length,
      pendingOutboxCount,
    };
  }

  async recordOutboxPublished(runId: string, roundId: number, commandId: string, streamId: string): Promise<void> {
    await this.mutate(async () => {
      requireText(streamId, "streamId");
      const worktree = requireWorktree(this.run(runId), roundId);
      const intent = worktree.intents[commandId];
      const outbox = worktree.outbox[commandId];
      if (intent === undefined || outbox === undefined) throw notFound(`unknown Financial outbox command: ${commandId}`);
      if (outbox.status !== "pending" && outbox.publishedStreamId !== streamId) {
        // A crash can occur after XADD but before this owner-state update. A
        // replay then produces a second transport entry for the same durable
        // command. Keep the earliest Stream ID as the execution order and
        // let a later duplicate be acknowledged idempotently by the worker.
        if (outbox.publishedStreamId !== undefined && compareStreamId(streamId, outbox.publishedStreamId) < 0) {
          outbox.publishedStreamId = streamId;
          intent.streamId = streamId;
        }
        return;
      }
      outbox.status = "published";
      outbox.publishedStreamId = streamId;
      intent.streamId = streamId;
    }, true);
  }

  /** Processes exactly one recorded Redis arrival, in numeric Stream ID order. */
  async processNextIntent(runId: string, roundId: number): Promise<{ commandId: string; status: "applied" | "rejected" } | undefined> {
    return this.mutate(async () => {
      const run = this.run(runId);
      const worktree = requireWorktree(run, roundId);
      const next = orderedIntents(worktree).find((intent) => intent.status === "pending" && intent.streamId !== undefined);
      if (next === undefined) return undefined;
      const marketMakerExecutionsBefore = clone(worktree.marketMakerExecutions ?? {});
      try {
        const snapshot = await this.materializeForPolicy(runId, roundId, worktree, [...appliedIntents(worktree), next]);
        next.status = "applied";
        worktree.outbox[next.commandId]!.status = "applied";
        const streamId = next.streamId;
        if (streamId === undefined) throw new Error("pending Financial intent has no Stream ID");
        worktree.lastAppliedStreamId = streamId;
        worktree.provisionalSnapshot = snapshot;
        return { commandId: next.commandId, status: "applied" };
      } catch (error) {
        // A rejected FOK/replace trial may have invoked deterministic
        // after-trade requotes. They are part of the failed trial and must not
        // leak into the accepted worktree.
        worktree.marketMakerExecutions = marketMakerExecutionsBefore;
        next.status = "rejected";
        next.rejectionReason = error instanceof Error ? error.message : String(error);
        worktree.outbox[next.commandId]!.status = "applied";
        return { commandId: next.commandId, status: "rejected" };
      }
    }, true);
  }

  /** Replays accepted commands from the parent revision, never compensating a live book. */
  async rebuildWorktree(runId: string, roundId: number, eligibleTurnIds: readonly string[]): Promise<FinancialRevisionSnapshot> {
    return this.mutate(async () => {
      const run = this.run(runId);
      const worktree = requireWorktree(run, roundId);
      const eligible = new Set(eligibleTurnIds);
      for (const intent of Object.values(worktree.intents)) {
        if (!eligible.has(intent.turnId) && intent.status !== "rejected") intent.status = "discarded";
      }
      const pending = orderedIntents(worktree).filter((intent) => intent.status === "pending" && intent.streamId === undefined);
      if (pending.length > 0) {
        throw precondition("Financial worktree cannot rebuild while durable intents have not reached Redis");
      }
      const snapshot = await this.materializeForPolicy(runId, roundId, worktree, appliedIntents(worktree));
      worktree.provisionalSnapshot = snapshot;
      return clone(snapshot);
    });
  }

  /**
   * Closes a Context-local branch and creates its immutable candidate revision.
   * Failed turns are excluded by rebuilding from the parent revision.
   */
  async sealCandidateRevision(input: {
    runId: string;
    roundId: number;
    /** Final provider failures are rebuilt out from the base revision. */
    finalFailedTurnIds: readonly string[];
    sourceManifestRef?: string;
  }): Promise<FinancialContextRevision> {
    return this.mutate(async () => {
      const run = this.run(input.runId);
      const worktree = requireWorktree(run, input.roundId);
      if (worktree.closed && worktree.candidateRevisionRef !== undefined) {
        return publicRevision(requireRevision(run, worktree.candidateRevisionRef));
      }
      const failed = new Set(input.finalFailedTurnIds);
      for (const intent of Object.values(worktree.intents)) {
        if (failed.has(intent.turnId) && intent.status !== "rejected") intent.status = "discarded";
      }
      const pending = orderedIntents(worktree).filter((intent) => intent.status === "pending");
      if (pending.length > 0) throw precondition("Financial worktree must drain all published intents before it can seal");
      await this.ensureMarketMakerExecution(input.runId, input.roundId, worktree, "settlement");
      const snapshot = await this.materializeForPolicy(input.runId, input.roundId, worktree, appliedIntents(worktree), true);
      const revision = makeRevision({
        runId: input.runId,
        roundId: input.roundId,
        kind: "candidate",
        parentRevisionRef: worktree.baseRevisionRef,
        snapshot,
        ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        now: this.now(),
      });
      run.revisions[revision.ref] ??= revision;
      worktree.candidateRevisionRef = revision.ref;
      worktree.closed = true;
      delete worktree.provisionalSnapshot;
      return publicRevision(run.revisions[revision.ref]!);
    }, true);
  }

  /** Moves the Context-local branch pointer after Experiment has committed its manifest. */
  async commitRevision(runId: string, revisionRef: string): Promise<FinancialContextRevision> {
    return this.mutate(async () => {
      const run = this.run(runId);
      const revision = requireRevision(run, revisionRef);
      run.revisionHeadRef = revision.ref;
      return publicRevision(revision);
    });
  }

  async forkRevision(input: {
    sourceRunId: string;
    sourceRevisionRef: string;
    targetRunId: string;
    sourceManifestRef?: string;
    /** undefined inherits, null clears, a value replaces the selection. */
    marketMaker?: MarketMakerSelection | null;
  }): Promise<FinancialContextRevision> {
    return this.mutate(async () => {
      requireText(input.targetRunId, "targetRunId");
      const sourceRun = this.run(input.sourceRunId);
      requireCommittedRevisionRef(sourceRun, input.sourceRevisionRef);
      const source = await this.loadRevision(input.sourceRevisionRef);
      const target = this.run(input.targetRunId);
      const existingHead = target.revisionHeadRef === undefined ? undefined : target.revisions[target.revisionHeadRef];
      if (existingHead !== undefined) {
        if (existingHead.parentRevisionRef !== source.ref) throw precondition("Financial fork target already belongs to a different source revision");
        return publicRevision(existingHead.snapshot === undefined ? await this.loadRevision(existingHead.ref) : existingHead);
      }
      const snapshot = clone(source.snapshot);
      if (input.marketMaker === null) {
        delete snapshot.marketMaker;
      } else if (input.marketMaker !== undefined) {
        this.market.validateSection({
          initialReferencePrice: snapshot.referencePrice,
          accounts: snapshot.accounts.map((account) => ({
            accountId: account.accountId,
            initialCash: account.cash,
            initialPosition: account.position,
            maximumActionsPerRound: account.maximumActionsPerRound,
          })),
          marketMaker: input.marketMaker,
        });
        snapshot.marketMaker = clone(input.marketMaker);
      }
      const revision = makeRevision({
        runId: input.targetRunId,
        roundId: source.roundId,
        kind: "committed",
        parentRevisionRef: source.ref,
        snapshot,
        ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
        now: this.now(),
      });
      target.revisions[revision.ref] ??= revision;
      target.revisionHeadRef = revision.ref;
      return publicRevision(target.revisions[revision.ref]!);
    });
  }

  /** Registers the Experiment principal allowed to operate one Financial account. */
  async provisionMcpBindings(input: {
    runId: string;
    roundId: number;
    revision: FinancialContextRevision;
    agents: readonly FinancialMcpAgent[];
  }): Promise<FinancialMcpBinding[]> {
    return this.mutate(async () => {
      const run = this.run(input.runId);
      const revisionHeader = requireRevision(run, input.revision.ref);
      const revision = revisionHeader.snapshot === undefined ? await this.loadRevision(revisionHeader.ref) : revisionHeader;
      if (revision.runId !== input.runId || revision.context !== "financial_market") {
        throw precondition("Financial MCP bindings must reference this run's Financial revision");
      }
      const worktree = run.roundWorkspaces[String(input.roundId)];
      if (worktree === undefined) {
        if (run.revisionHeadRef !== revision.ref || revision.roundId !== input.roundId) {
          throw precondition("baseline Financial MCP bindings must use this run's committed revision");
        }
      } else {
        if (worktree.readRevisionRef !== revision.ref) {
          throw precondition("Financial MCP bindings must use this round's frozen revision");
        }
      }
      const agentIds = new Set<string>();
      const principalIds = new Set<string>();
      const bindings: FinancialMcpBinding[] = [];
      for (const agent of input.agents) {
        requireText(agent.agentId, "agentId");
        requireText(agent.principalId, "principalId");
        const parsedPermissions = financialMcpPermissionsSchema.safeParse(agent.permissions);
        if (!parsedPermissions.success) {
          throw invalid("Financial MCP permissions are invalid", "agents.permissions");
        }
        const permissions = clone(parsedPermissions.data);
        if (agentIds.has(agent.agentId) || principalIds.has(agent.principalId)) {
          throw invalid("Financial MCP agent and principal IDs must be unique", "agents");
        }
        agentIds.add(agent.agentId);
        principalIds.add(agent.principalId);
        if (agent.accountId !== undefined && !revision.snapshot.accounts.some((account) => account.accountId === agent.accountId)) {
          throw notFound(`unknown Financial account: ${agent.accountId}`);
        }
        if (
          agent.accountId === undefined
          && (
            permissions.tools.some((tool) => !MARKET_READ_TOOLS.has(tool))
            || permissions.resources.some((resource) => resource !== "financial.market")
          )
        ) {
          throw precondition("an accountless Financial principal may only use public market reads");
        }
        if (run.mcp.accessRevokedAt !== undefined) throw precondition("Financial MCP access has been revoked for this run");
        const existingAgent = run.mcp.principals.find((principal) => principal.agentId === agent.agentId);
        const existingPrincipal = run.mcp.principals.find((principal) => principal.principalId === agent.principalId);
        if (existingAgent !== undefined || existingPrincipal !== undefined) {
          if (
            existingAgent?.principalId !== agent.principalId ||
            existingAgent?.accountId !== agent.accountId ||
            existingPrincipal?.agentId !== agent.agentId ||
            existingPrincipal?.accountId !== agent.accountId ||
            !samePermissions(existingAgent ?? existingPrincipal!, permissions)
          ) {
            throw precondition("Financial MCP principal registration conflicts with an existing account or permission binding");
          }
          bindings.push({ context: "financial", agentId: agent.agentId, endpoint: this.endpoint });
          continue;
        }
        run.mcp.principals.push({
          agentId: agent.agentId,
          principalId: agent.principalId,
          ...(agent.accountId === undefined ? {} : { accountId: agent.accountId }),
          permissions,
        });
        bindings.push({ context: "financial", agentId: agent.agentId, endpoint: this.endpoint });
      }
      return bindings;
    });
  }

  /** Opens a pinned scope for an already registered Experiment principal. */
  async openMcpScope(input: {
    runId: string;
    roundId: number;
    agentId: string;
    principalId: string;
    readRevision: FinancialContextRevision;
    turnId: string;
    attemptId?: string;
    ttlMs?: number;
  }): Promise<FinancialMcpScope> {
    return this.mutate(async () => {
      const run = this.run(input.runId);
      const revision = requireRevision(run, input.readRevision.ref);
      const worktree = requireWorktree(run, input.roundId);
      if (revision.runId !== input.runId || revision.roundId !== input.roundId || worktree.readRevisionRef !== revision.ref) {
        throw precondition("Financial MCP scope must pin this round's read revision");
      }
      if (run.mcp.accessRevokedAt !== undefined) throw precondition("Financial MCP access has been revoked for this run");
      const principal = run.mcp.principals.find((candidate) => candidate.agentId === input.agentId && candidate.principalId === input.principalId);
      if (principal === undefined) throw notFound(`Financial MCP principal was not registered for ${input.agentId}`);
      const previous = run.mcp.activeScopes.find((scope) =>
        scope.principalId === principal.principalId
        && scope.roundId === input.roundId
        && scope.turnId === input.turnId
        && scope.attemptId === input.attemptId
        && scope.expiresAt > this.now().toISOString(),
      );
      if (previous !== undefined) return clone(previous);
      const scope: FinancialMcpScope = {
        scopeId: `financial-scope:${randomUUID()}`,
        runId: input.runId,
        roundId: input.roundId,
        agentId: input.agentId,
        principalId: principal.principalId,
        ...(principal.accountId === undefined ? {} : { accountId: principal.accountId }),
        readRevisionRef: revision.ref,
        turnId: input.turnId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        expiresAt: new Date(this.now().getTime() + (input.ttlMs ?? 15 * 60_000)).toISOString(),
      };
      run.mcp.activeScopes = [
        ...run.mcp.activeScopes.filter((candidate) => candidate.principalId !== principal.principalId),
        scope,
      ];
      return scope;
    });
  }

  async closeMcpScope(input: { runId: string; scopeId: string }): Promise<void> {
    await this.mutate(async () => {
      const run = this.run(input.runId);
      const index = run.mcp.activeScopes.findIndex((scope) => scope.scopeId === input.scopeId);
      if (index >= 0) run.mcp.activeScopes.splice(index, 1);
    });
  }

  /** Immediately invalidates all currently-issued and future bearer access for a run. */
  async revokeMcpAccess(runId: string): Promise<void> {
    await this.mutate(async () => {
      const run = this.run(runId);
      run.mcp.accessRevokedAt ??= this.now().toISOString();
      run.mcp.activeScopes = [];
    });
  }

  async listMcpResources(bearerToken: string): Promise<FinancialMcpResource[]> {
    const { revision, scope, registration } = await this.authorize(bearerToken);
    const root = revisionUri(revision.ref);
    const resources: Array<FinancialMcpResource & { capability: FinancialMcpResourceId }> = [
      { capability: "financial.market", uri: `${root}/market`, name: "Frozen market", mimeType: "application/json", description: `Market summary and first newest-trades page for round ${scope.roundId}` },
      ...(scope.accountId === undefined ? [] : [
        { capability: "financial.account" as const, uri: `${root}/accounts/${encodeURIComponent(scope.accountId)}`, name: "Frozen account", mimeType: "application/json" as const, description: "Your account in the pinned Financial revision" },
        { capability: "financial.orders" as const, uri: `${root}/orders`, name: "Frozen orders", mimeType: "application/json" as const, description: "First newest-orders page for your account in the pinned Financial revision" },
      ]),
    ];
    return resources
      .filter((resource) => permitsResource(registration, resource.capability))
      .map(({ capability: _capability, ...resource }) => resource);
  }

  async listMcpTools(bearerToken: string): Promise<string[]> {
    const { registration } = await this.authorize(bearerToken);
    // Pre-policy registrations retain precisely their historical discovery
    // surface. New broker capabilities require an explicit published policy.
    if (registration.legacyFullAccess === true) return registration.accountId === undefined ? [] : ["place_order", "cancel_order"];
    return ([
      ["get_quote", "financial.get_quote"],
      ["get_order_book", "financial.get_order_book"],
      ["get_candles", "financial.get_candles"],
      ["list_market_trades", "financial.list_market_trades"],
      ["list_market_orders", "financial.list_market_orders"],
      ["get_account", "financial.get_account"],
      ["list_orders", "financial.list_orders"],
      ["list_executions", "financial.list_executions"],
      ["preview_order", "financial.preview_order"],
      ["place_order", "financial.place_order"],
      ["place_limit_order", "financial.place_limit_order"],
      ["place_market_order", "financial.place_market_order"],
      ["replace_order", "financial.replace_order"],
      ["cancel_order", "financial.cancel_order"],
    ] as const)
      .filter(([, capability]) => registration.accountId !== undefined || MARKET_READ_TOOLS.has(capability))
      .filter(([, capability]) => permitsTool(registration, capability))
      .map(([name]) => name);
  }

  /** Validates both the Experiment JWS and Financial's local principal/scope state. */
  async assertMcpAccess(bearerToken: string): Promise<void> {
    await this.authorize(bearerToken);
  }

  async readMcpResource(bearerToken: string, uri: string): Promise<FinancialMcpRead> {
    const { revision, scope, registration } = await this.authorize(bearerToken);
    const parsed = parseRevisionUri(uri);
    if (parsed.revisionRef !== revision.ref) throw precondition("MCP resource does not belong to this pinned Financial revision");
    assertResourceAllowed(registration, resourceCapability(parsed.kind));
    const snapshot = revision.snapshot;
    let value: unknown;
    if (parsed.kind === "market") value = marketResource(snapshot, revision, parsed.cursor);
    else if (parsed.kind === "orders") {
      value = orderResource(snapshot, revision.ref, requireBoundAccount(scope), parsed.cursor);
    }
    else {
      if (parsed.accountId !== scope.accountId) throw precondition("Financial MCP principal may read only its bound account");
      const account = snapshot.accounts.find((candidate) => candidate.accountId === scope.accountId);
      if (account === undefined) throw notFound(`unknown Financial account: ${scope.accountId}`);
      value = publicAccount(account, snapshot);
    }
    return { mimeType: "application/json", text: JSON.stringify(value) };
  }

  async callMcpQuery(input: { bearerToken: string; name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    const { revision, scope, registration } = await this.authorize(input.bearerToken);
    const capability = `financial.${input.name}` as FinancialMcpToolId;
    assertToolAllowed(registration, capability);
    const envelope = { revisionRef: revision.ref, roundId: revision.roundId };
    const snapshot = revision.snapshot;
    if (input.name === "get_quote") {
      return { ...envelope, ...quote(snapshot) };
    }
    if (input.name === "get_order_book") {
      const depth = boundedInteger(input.arguments.depth, 10, 1, 50, "depth");
      const book = orderBook(snapshot, depth);
      return { ...envelope, ...book };
    }
    if (input.name === "get_candles") {
      const limit = boundedInteger(input.arguments.limit, 20, 1, 100, "limit");
      return { ...envelope, candles: (await candlesFromLineage(this, revision.ref)).slice(-limit) };
    }
    if (input.name === "list_market_trades") {
      const roundId = optionalInteger(input.arguments.roundId, 0, Number.MAX_SAFE_INTEGER, "roundId");
      const limit = boundedInteger(input.arguments.limit, 100, 1, 500, "limit");
      const offset = boundedInteger(input.arguments.offset, 0, 0, 100_000, "offset");
      const orders = new Map(snapshot.orders.map((order) => [order.orderId, order]));
      const all = snapshot.trades
        .map((trade, index) => ({ trade, tradeSequence: index + 1 }))
        .filter(({ trade }) => roundId === undefined || trade.roundId === roundId)
        .map(({ trade, tradeSequence }) => ({
          tradeSequence,
          roundId: trade.roundId,
          price: publicMoney(trade.price, snapshot),
          quantity: trade.quantity,
          buyOrderSequence: orders.get(trade.buyOrderId)?.createdSequence ?? null,
          sellOrderSequence: orders.get(trade.sellOrderId)?.createdSequence ?? null,
        }));
      return {
        ...envelope,
        symbol: snapshot.symbol ?? "ASSET",
        total: all.length,
        offset,
        trades: all.slice(offset, offset + limit),
      };
    }
    if (input.name === "list_market_orders") {
      const side = optionalText(input.arguments.side);
      if (side !== undefined && side !== "buy" && side !== "sell") {
        throw precondition("side must be buy or sell");
      }
      const limit = boundedInteger(input.arguments.limit, 100, 1, 500, "limit");
      const offset = boundedInteger(input.arguments.offset, 0, 0, 100_000, "offset");
      const all = snapshot.orders
        .filter((order) =>
          order.status === "open"
          && (order.orderType ?? "limit") === "limit"
          && order.limitPrice !== undefined
          && (side === undefined || order.side === side))
        .sort((left, right) => left.createdSequence - right.createdSequence)
        .map((order) => ({
          orderSequence: order.createdSequence,
          side: order.side,
          limitPrice: publicMoney(order.limitPrice!, snapshot),
          quantity: order.quantity,
          remainingQuantity: order.remaining,
          timeInForce: order.timeInForce,
          ...(order.expiresAtRound === undefined ? {} : { expiresAtRound: order.expiresAtRound }),
        }));
      return {
        ...envelope,
        symbol: snapshot.symbol ?? "ASSET",
        total: all.length,
        offset,
        orders: all.slice(offset, offset + limit),
      };
    }
    const accountId = requireBoundAccount(scope);
    if (input.name === "get_account") {
      return { ...envelope, tickSize: tickSizeFor(snapshot), account: publicAccount(requireSnapshotAccount(snapshot, accountId), snapshot) };
    }
    if (input.name === "list_orders") {
      const status = optionalText(input.arguments.status);
      const side = optionalText(input.arguments.side);
      const orderType = optionalText(input.arguments.orderType);
      const limit = boundedInteger(input.arguments.limit, 50, 1, 100, "limit");
      const offset = boundedInteger(input.arguments.offset, 0, 0, 100_000, "offset");
      const all = snapshot.orders.filter((order) =>
        order.accountId === accountId
        && (status === undefined || order.status === status)
        && (side === undefined || order.side === side)
        && (orderType === undefined || (order.orderType ?? "limit") === orderType));
      return { ...envelope, tickSize: tickSizeFor(snapshot), total: all.length, offset, orders: all.slice(offset, offset + limit).map((order) => publicOrder(order, snapshot)) };
    }
    if (input.name === "list_executions") {
      const orders = new Map(snapshot.orders.map((order) => [order.orderId, order]));
      const orderId = optionalText(input.arguments.orderId);
      const limit = boundedInteger(input.arguments.limit, EXECUTION_DEFAULT_LIMIT, 1, 100, "limit");
      const offset = parsePageCursor(input.arguments.cursor, "cursor");
      const executions = snapshot.trades.flatMap((trade) => {
        const buy = orders.get(trade.buyOrderId);
        const sell = orders.get(trade.sellOrderId);
        const own = buy?.accountId === accountId ? buy : sell?.accountId === accountId ? sell : undefined;
        const counter = own === buy ? sell : buy;
        if (own === undefined || counter === undefined || (orderId !== undefined && own.orderId !== orderId)) return [];
        return [{
          executionId: trade.tradeId,
          orderId: own.orderId,
          side: own.side,
          quantity: trade.quantity,
          price: publicMoney(trade.price, snapshot),
          roundId: trade.roundId,
          liquidityRole: own.createdSequence < counter.createdSequence ? "maker" : "taker",
          counterpartyType: counter.origin === "market_maker" ? "market_maker" : "participant",
        }];
      }).reverse();
      const page = executions.slice(offset, offset + limit);
      return {
        ...envelope,
        tickSize: tickSizeFor(snapshot),
        executions: page,
        ...(offset + page.length < executions.length ? { nextCursor: String(offset + page.length) } : {}),
      };
    }
    if (input.name === "preview_order") {
      const side = brokerSide(input.arguments.side);
      const orderType = input.arguments.orderType === "limit" ? "limit" : input.arguments.orderType === "market" ? "market" : undefined;
      if (orderType === undefined) throw invalid("orderType must be limit or market", "orderType");
      const units = unitsForSnapshot(snapshot);
      const price = orderType === "limit" ? priceToUnits(positiveNumberValue(input.arguments.limitPrice, "limitPrice"), units, "limitPrice") : undefined;
      const sizingInput = publicSizingToUnits(input.arguments, units);
      const sizing = resolveSizing(snapshot, accountId, side, sizingInput, price);
      return { ...envelope, tickSize: tickSizeFor(snapshot), preview: publicPreview(preview(snapshot, accountId, side, sizing.quantity, orderType, price, sizing.cashBudget), snapshot) };
    }
    throw invalid(`unknown Financial query tool: ${input.name}`, "name");
  }

  async enqueueMcpOrder(input: {
    bearerToken: string;
    invocationId: string;
    side: "buy" | "sell";
    quantity: number;
    limitPrice: number;
    timeInForce?: "gtc" | "ioc" | "fok";
    ttlRounds?: number;
    rationale?: string;
  }): Promise<FinancialIntentRecord> {
    const { revision, scope, registration } = await this.authorize(input.bearerToken);
    assertToolAllowed(registration, "financial.place_order");
    const accountId = requireBoundAccount(scope);
    const actionId = financialMcpActionId(scope, "place_order", input.invocationId);
    return this.enqueueIntent({
      runId: scope.runId,
      roundId: scope.roundId,
      agentId: scope.agentId,
      accountId,
      turnId: scope.turnId,
      ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
      action: {
        type: "submitOrder",
        actionId,
        accountId,
        side: input.side,
        quantity: input.quantity,
        limitPrice: priceToUnits(input.limitPrice, unitsForSnapshot(revision.snapshot), "limitPrice"),
        ...(input.ttlRounds === undefined ? {} : { expiresAtRound: scope.roundId + input.ttlRounds }),
        ...(input.timeInForce === undefined ? {} : { timeInForce: input.timeInForce }),
      },
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    });
  }

  async enqueueMcpLimitOrder(input: {
    bearerToken: string;
    invocationId: string;
    side: "buy" | "sell";
    quantity?: number;
    cashAmount?: number;
    fraction?: number;
    limitPrice: number;
    timeInForce?: "gtc" | "ioc" | "fok";
    ttlRounds?: number;
    rationale?: string;
  }): Promise<FinancialIntentRecord> {
    const { revision, scope, registration } = await this.authorize(input.bearerToken);
    assertToolAllowed(registration, "financial.place_limit_order");
    const accountId = requireBoundAccount(scope);
    const units = unitsForSnapshot(revision.snapshot);
    const actionId = financialMcpActionId(scope, "place_limit_order", input.invocationId);
    const limitPrice = priceToUnits(input.limitPrice, units, "limitPrice");
    const sizing = resolveSizing(revision.snapshot, accountId, input.side, publicSizingToUnits(input, units), limitPrice);
    return this.enqueueIntent({
      runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, accountId, turnId: scope.turnId,
      ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      action: {
        type: "submitOrder", actionId, accountId, side: input.side,
        quantity: sizing.quantity, limitPrice,
        ...(input.ttlRounds === undefined ? {} : { expiresAtRound: scope.roundId + input.ttlRounds }),
        ...(input.timeInForce === undefined ? {} : { timeInForce: input.timeInForce }),
      },
    });
  }

  async enqueueMcpMarketOrder(input: {
    bearerToken: string;
    invocationId: string;
    side: "buy" | "sell";
    quantity?: number;
    cashAmount?: number;
    fraction?: number;
    timeInForce: "ioc" | "fok";
    rationale?: string;
  }): Promise<FinancialIntentRecord> {
    const { revision, scope, registration } = await this.authorize(input.bearerToken);
    assertToolAllowed(registration, "financial.place_market_order");
    const accountId = requireBoundAccount(scope);
    const actionId = financialMcpActionId(scope, "place_market_order", input.invocationId);
    const sizing = resolveSizing(revision.snapshot, accountId, input.side, publicSizingToUnits(input, unitsForSnapshot(revision.snapshot)));
    return this.enqueueIntent({
      runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, accountId, turnId: scope.turnId,
      ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      action: {
        type: "submitMarketOrder", actionId, accountId, side: input.side,
        quantity: sizing.quantity, timeInForce: input.timeInForce,
        ...(sizing.cashBudget === undefined ? {} : { cashBudget: sizing.cashBudget }),
      },
    });
  }

  async enqueueMcpReplacement(input: {
    bearerToken: string;
    invocationId: string;
    orderId: string;
    side: "buy" | "sell";
    quantity?: number;
    cashAmount?: number;
    fraction?: number;
    limitPrice: number;
    timeInForce?: "gtc" | "ioc" | "fok";
    ttlRounds?: number;
    rationale?: string;
  }): Promise<FinancialIntentRecord> {
    const { revision, scope, registration } = await this.authorize(input.bearerToken);
    assertToolAllowed(registration, "financial.replace_order");
    const accountId = requireBoundAccount(scope);
    const units = unitsForSnapshot(revision.snapshot);
    const actionId = financialMcpActionId(scope, "replace_order", input.invocationId);
    const replacementOrderId = `financial-order:${sha256({ actionId, kind: "replacement" })}`;
    const limitPrice = priceToUnits(input.limitPrice, units, "limitPrice");
    const sizing = resolveSizing(revision.snapshot, accountId, input.side, publicSizingToUnits(input, units), limitPrice);
    return this.enqueueIntent({
      runId: scope.runId, roundId: scope.roundId, agentId: scope.agentId, accountId, turnId: scope.turnId,
      ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      action: {
        type: "replaceOrder", actionId,
        accountId, orderId: input.orderId, replacementOrderId,
        side: input.side, quantity: sizing.quantity, limitPrice,
        ...(input.ttlRounds === undefined ? {} : { expiresAtRound: scope.roundId + input.ttlRounds }),
        ...(input.timeInForce === undefined ? {} : { timeInForce: input.timeInForce }),
      },
    });
  }

  async enqueueMcpCancellation(input: { bearerToken: string; invocationId: string; orderId: string }): Promise<FinancialIntentRecord> {
    const { scope, registration } = await this.authorize(input.bearerToken);
    assertToolAllowed(registration, "financial.cancel_order");
    const accountId = requireBoundAccount(scope);
    const actionId = financialMcpActionId(scope, "cancel_order", input.invocationId);
    return this.enqueueIntent({
      runId: scope.runId,
      roundId: scope.roundId,
      agentId: scope.agentId,
      accountId,
      turnId: scope.turnId,
      ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
      action: {
        type: "cancelOrder",
        actionId,
        accountId,
        orderId: input.orderId,
      },
    });
  }

  getRevision(revisionRef: string): StoredFinancialRevision {
    for (const run of Object.values(this.state.runs)) {
      const revision = run.revisions[revisionRef];
      if (revision?.snapshot !== undefined) return clone(revision);
    }
    throw notFound(`unknown Financial revision: ${revisionRef}`);
  }

  async loadRevision(revisionRef: string): Promise<StoredFinancialRevision> {
    for (const run of Object.values(this.state.runs)) {
      const revision = run.revisions[revisionRef];
      if (revision?.snapshot !== undefined) return clone(revision);
    }
    const revision = await this.store.loadRevision(revisionRef);
    if (revision === undefined) throw notFound(`unknown Financial revision: ${revisionRef}`);
    return clone(revision);
  }

  /** Manifest-facing committed facts derived from the immutable revision itself. */
  async getCommittedRevisionFacts(runId: string, revisionRef: string): Promise<{
    revision: FinancialContextRevision;
    tickSize: number;
    summary: MarketSummary;
    trades: Trade[];
  }> {
    requireCommittedRevisionRef(this.run(runId), revisionRef);
    const revision = await this.loadRevision(revisionRef);
    const { nextUri: _nextUri, ...market } = marketResource(revision.snapshot, revision);
    return {
      ...market,
      trades: revision.snapshot.trades.map((trade) => publicTrade(trade, revision.snapshot)),
    };
  }

  /** Public, account-free market terminal projection for a committed revision. */
  async getObserverSnapshot(runId: string, revisionRef: string, depth = 20): Promise<{
    revision: FinancialContextRevision;
    quote: ReturnType<typeof quote>;
    candles: Awaited<ReturnType<typeof candlesFromLineage>>;
    orderBook: ReturnType<typeof orderBook>;
    trades: Array<{
      tradeSequence: number;
      roundId: number;
      price: number;
      quantity: number;
      buyOrderSequence: number | null;
      sellOrderSequence: number | null;
    }>;
    orders: Array<{
      orderSequence: number;
      side: "buy" | "sell";
      limitPrice: number;
      quantity: number;
      remainingQuantity: number;
      timeInForce: string;
      expiresAtRound?: number;
    }>;
    delta: {
      previousRevisionRef?: string;
      lastPrice: number;
      bestBid: number;
      bestAsk: number;
      newTradeCount: number;
      addedOrderSequences: number[];
      removedOrderSequences: number[];
    };
  }> {
    const run = this.run(runId);
    requireCommittedRevisionRef(run, revisionRef);
    const revision = await this.loadRevision(revisionRef);
    const snapshot = revision.snapshot;
    const currentQuote = quote(snapshot);
    const orderById = new Map(snapshot.orders.map((order) => [order.orderId, order]));
    const trades = snapshot.trades.map((trade, index) => ({
      tradeSequence: index + 1,
      roundId: trade.roundId,
      price: publicMoney(trade.price, snapshot),
      quantity: trade.quantity,
      buyOrderSequence: orderById.get(trade.buyOrderId)?.createdSequence ?? null,
      sellOrderSequence: orderById.get(trade.sellOrderId)?.createdSequence ?? null,
    }));
    const orders = publicOpenOrders(snapshot);
    const parent = revision.parentRevisionRef === undefined
      ? undefined
      : await this.loadRevision(revision.parentRevisionRef);
    const parentSnapshot = parent?.snapshot;
    const parentQuote = parentSnapshot === undefined ? currentQuote : quote(parentSnapshot);
    const parentOrders = parentSnapshot === undefined ? [] : publicOpenOrders(parentSnapshot);
    const currentSequences = new Set(orders.map((order) => order.orderSequence));
    const parentSequences = new Set(parentOrders.map((order) => order.orderSequence));
    return clone({
      revision: publicRevision(revision),
      quote: currentQuote,
      candles: await candlesFromLineage(this, revision.ref),
      orderBook: orderBook(snapshot, Math.max(1, Math.min(50, Math.trunc(depth)))),
      trades,
      orders,
      delta: {
        ...(parent === undefined ? {} : { previousRevisionRef: parent.ref }),
        lastPrice: publicMoneyDelta(currentQuote.lastPrice, parentQuote.lastPrice, snapshot),
        bestBid: publicMoneyDelta(currentQuote.bestBid, parentQuote.bestBid, snapshot),
        bestAsk: publicMoneyDelta(currentQuote.bestAsk, parentQuote.bestAsk, snapshot),
        newTradeCount: trades.filter((trade) => trade.roundId === revision.roundId).length,
        addedOrderSequences: [...currentSequences].filter((sequence) => !parentSequences.has(sequence)),
        removedOrderSequences: [...parentSequences].filter((sequence) => !currentSequences.has(sequence)),
      },
    });
  }

  getWorktree(runId: string, roundId: number): FinancialRoundWorkspace {
    return clone(requireWorktree(this.run(runId), roundId));
  }

  /**
   * Dedicated runner-only read surface. This intentionally does not share an
   * MCP scope or Agent bearer: a capability binds one execution, maker account
   * and committed lineage head.
   */
  async readMarketMakerHistory(input: {
    capability: string;
    operation: "all" | "round" | "makerAccount" | "participantBaseline";
    cursor?: string;
    roundId?: number;
  }): Promise<unknown> {
    requireText(input.capability, "capability");
    const capability = this.state.marketMakerHistoryCapabilities[input.capability];
    if (capability === undefined || capability.expiresAt <= this.now().toISOString()) {
      throw precondition("market maker history capability is inactive or expired");
    }
    const head = await this.loadRevision(capability.committedHeadRevisionRef);
    if (head.runId !== capability.runId || !isCommittedRevision(this.run(capability.runId), head.ref)) {
      throw precondition("market maker history capability does not name a committed Financial revision");
    }
    if (input.operation === "makerAccount") {
      const snapshot = this.transientMarketMakerSnapshots.get(input.capability)?.snapshot ?? head.snapshot;
      const account = snapshot.accounts.find((item) => item.accountId === capability.makerAccountId);
      if (account === undefined) throw notFound(`unknown market maker account: ${capability.makerAccountId}`);
      const replacementAvailability = marketMakerReplacementAvailability(snapshot, account.accountId);
      return {
        accountId: account.accountId,
        cash: publicMoney(account.cash, snapshot),
        position: account.position,
        reservedCash: publicMoney(account.reservedCash, snapshot),
        reservedPosition: account.reservedPosition,
        replacementAvailableCash: publicMoney(replacementAvailability.cash, snapshot),
        replacementAvailablePosition: replacementAvailability.position,
        tickSize: tickSizeFor(snapshot),
      };
    }
    if (input.operation === "participantBaseline") {
      const baseline = (await initialRevisionForRun(this, capability.runId, head.ref)).snapshot;
      const participants = baseline.accounts.filter((account) => account.accountId !== capability.makerAccountId);
      return {
        accountCount: participants.length,
        totalCash: publicMoney(participants.reduce((total, account) => total + account.cash, 0), baseline),
        totalPosition: participants.reduce((total, account) => total + account.position, 0),
        tickSize: tickSizeFor(baseline),
      };
    }
    const records = await committedHistoryRecords(this, capability.runId, head.ref, capability.makerAccountId);
    const transient = this.transientMarketMakerSnapshots.get(input.capability);
    if (transient !== undefined) {
      const record = historyRecord({
        ...head,
        roundId: transient.roundId,
        snapshot: transient.snapshot,
      }, marketReferencePrice(head.snapshot), capability.makerAccountId);
      const index = records.findIndex((item) => item.roundId === record.roundId);
      if (index === -1) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.roundId - right.roundId);
    }
    if (input.operation === "round") {
      if (!Number.isSafeInteger(input.roundId) || input.roundId! < 0) throw invalid("roundId must be a non-negative safe integer", "roundId");
      const record = [...records].reverse().find((item) => item.roundId === input.roundId);
      if (record === undefined) throw notFound(`no committed Financial history for round ${input.roundId}`);
      return clone(record);
    }
    const offset = parseHistoryCursor(input.cursor);
    const pageSize = 100;
    const page = records.slice(offset, offset + pageSize);
    return {
      records: clone(page),
      ...(offset + page.length < records.length ? { nextCursor: String(offset + page.length) } : {}),
    };
  }

  /** Read-only Console preview against an existing committed Financial revision. */
  async previewMarketMaker(input: {
    versionRef: string;
    config: Record<string, unknown>;
    runId: string;
    revisionRef: string;
    seed: string;
    accountId: string;
    timing: MarketMakerTiming;
  }): Promise<MarketMakerOrderIntent[]> {
    return this.serialized(async () => {
      requireText(input.seed, "seed");
      const run = this.state.runs[input.runId];
      if (run === undefined) throw notFound(`unknown Financial run: ${input.runId}`);
      const revision = requireCommittedRevision(run, input.revisionRef);
      if (!revision.snapshot.accounts.some((account) => account.accountId === input.accountId)) {
        throw notFound(`unknown market maker account: ${input.accountId}`);
      }
      const capability = `market-maker-history:${randomUUID()}`;
      const executionId = `market-maker-preview:${sha256({ runId: input.runId, revisionRef: revision.ref, versionRef: input.versionRef, accountId: input.accountId, timing: input.timing, seed: input.seed })}`;
      this.state.marketMakerHistoryCapabilities[capability] = {
        capability,
        runId: input.runId,
        makerAccountId: input.accountId,
        committedHeadRevisionRef: revision.ref,
        executionId,
        expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      };
      try {
        const result = await this.market.executeMarketMaker({
          selection: {
            versionRef: input.versionRef,
            accountId: input.accountId,
            timing: input.timing,
            config: clone(input.config),
          },
          roundId: revision.roundId,
          seed: input.seed,
          financialHistory: { endpoint: this.marketMakerHistoryEndpoint, capability },
          priceUnits: unitsForSnapshot(revision.snapshot),
        });
        return result.orders.map((order) => ({ ...clone(order), limitPrice: publicMoney(order.limitPrice, revision.snapshot) }));
      } finally {
        delete this.state.marketMakerHistoryCapabilities[capability];
      }
    });
  }

  /** Discovery view for the Context's injected Redis consumer loop. */
  listWorkerStreams(): Array<{ runId: string; roundId: number; streamKey: string }> {
    const streams: Array<{ runId: string; roundId: number; streamKey: string }> = [];
    for (const [runId, run] of Object.entries(this.state.runs)) {
      for (const worktree of Object.values(run.roundWorkspaces)) {
        if (worktree.closed) continue;
        const streamKey = Object.values(worktree.outbox)[0]?.streamKey;
        if (streamKey !== undefined) streams.push({ runId, roundId: worktree.roundId, streamKey });
      }
    }
    return streams.sort((left, right) => left.streamKey.localeCompare(right.streamKey));
  }

  private outboxRecords(runId: string, roundId: number): FinancialOutboxRecord[] {
    return Object.values(requireWorktree(this.run(runId), roundId).outbox)
      .sort((left, right) => left.commandId.localeCompare(right.commandId))
      .map((item) => clone(item));
  }

  private materialize(
    runId: string,
    roundId: number,
    worktree: FinancialRoundWorkspace,
    intents: readonly FinancialIntentRecord[],
    includeSettlement = false,
  ): FinancialRevisionSnapshot {
    const base = this.getRevision(worktree.baseRevisionRef);
    const ordered = [...intents]
      .filter((intent) => intent.status === "applied" || intent.status === "pending")
      .sort(compareIntentStream);
    return this.market.materializeRoundFromSnapshot({
      runId,
      roundId,
      base: base.snapshot,
      actions: ordered.map((intent) => intent.action),
      ...(worktree.marketMakerExecutions?.opening === undefined
        ? {}
        : { openingMarketMakerOrders: worktree.marketMakerExecutions.opening.orders }),
      ...(!includeSettlement || worktree.marketMakerExecutions?.settlement === undefined
        ? {}
        : { settlementMarketMakerOrders: worktree.marketMakerExecutions.settlement.orders }),
    }).material;
  }

  private async materializeForPolicy(
    runId: string,
    roundId: number,
    worktree: FinancialRoundWorkspace,
    intents: readonly FinancialIntentRecord[],
    includeSettlement = false,
  ): Promise<FinancialRevisionSnapshot> {
    const base = this.getRevision(worktree.baseRevisionRef);
    const selection = base.snapshot.marketMaker;
    if (selection?.matchingPolicy !== "incremental") {
      return this.materialize(runId, roundId, worktree, intents, includeSettlement);
    }
    const ordered = [...intents]
      .filter((intent) => intent.status === "applied" || intent.status === "pending")
      .sort(compareIntentStream);
    const result = await this.market.materializeRoundIncrementallyFromSnapshot({
      runId,
      roundId,
      base: base.snapshot,
      actions: ordered.map((intent) => intent.action),
      ...(worktree.marketMakerExecutions?.opening === undefined
        ? {}
        : { openingMarketMakerOrders: worktree.marketMakerExecutions.opening.orders }),
      ...(!includeSettlement || worktree.marketMakerExecutions?.settlement === undefined
        ? {}
        : { settlementMarketMakerOrders: worktree.marketMakerExecutions.settlement.orders }),
      ...(selection.requotePolicy !== "after_each_trade"
        ? {}
        : {
            afterTrade: async ({ trade, material }: { trade: Trade; material: MaterialMarketState }) =>
              this.ensureAfterTradeMarketMakerExecution(runId, roundId, worktree, selection, trade, material),
          }),
    });
    return result.material;
  }

  private async ensureAfterTradeMarketMakerExecution(
    runId: string,
    roundId: number,
    worktree: FinancialRoundWorkspace,
    selection: MarketMakerSelection,
    trade: Trade,
    snapshot: FinancialRevisionSnapshot,
  ): Promise<readonly MarketMakerOrderIntent[]> {
    const triggerDigest = sha256({
      trade,
      accounts: snapshot.accounts,
      orders: snapshot.orders,
      sequence: snapshot.sequence,
    });
    const key = `trade:${trade.tradeId}:${triggerDigest.slice(0, 16)}`;
    const existing = worktree.marketMakerExecutions?.[key];
    if (existing !== undefined) return clone(existing.orders);
    const base = this.getRevision(worktree.baseRevisionRef);
    const committedHead = requireCommittedRevision(this.run(runId), base.ref);
    const executionId = `market-maker-execution:${sha256({
      runId,
      roundId,
      trigger: "after_trade",
      tradeId: trade.tradeId,
      triggerDigest,
      versionRef: selection.versionRef,
      accountId: selection.accountId,
      committedHeadRevisionRef: committedHead.ref,
    })}`;
    const capability = `market-maker-history:${randomUUID()}`;
    this.state.marketMakerHistoryCapabilities[capability] = {
      capability,
      runId,
      makerAccountId: selection.accountId,
      committedHeadRevisionRef: committedHead.ref,
      executionId,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
    };
    this.transientMarketMakerSnapshots.set(capability, { roundId, snapshot });
    try {
      const seed = sha256({ runId, roundId, trigger: "after_trade", tradeId: trade.tradeId, triggerDigest, versionRef: selection.versionRef });
      const result = await this.market.executeMarketMaker({
        selection,
        roundId,
        seed,
        financialHistory: { endpoint: this.marketMakerHistoryEndpoint, capability },
        priceUnits: unitsForSnapshot(snapshot),
      });
      const execution: FinancialMarketMakerExecution = {
        executionId,
        timing: selection.timing,
        trigger: "after_trade",
        roundId,
        versionRef: selection.versionRef,
        accountId: selection.accountId,
        config: clone(selection.config),
        seed,
        committedHeadRevisionRef: committedHead.ref,
        orders: clone(result.orders),
        createdAt: this.now().toISOString(),
      };
      worktree.marketMakerExecutions ??= {};
      worktree.marketMakerExecutions[key] = execution;
      return clone(execution.orders);
    } finally {
      this.transientMarketMakerSnapshots.delete(capability);
      delete this.state.marketMakerHistoryCapabilities[capability];
    }
  }

  private async ensureMarketMakerExecution(
    runId: string,
    roundId: number,
    worktree: FinancialRoundWorkspace,
    timing: MarketMakerTiming,
  ): Promise<FinancialMarketMakerExecution | undefined> {
    const existing = worktree.marketMakerExecutions?.[timing];
    if (existing !== undefined) return existing;
    const base = this.getRevision(worktree.baseRevisionRef);
    const selection = base.snapshot.marketMaker;
    if (selection === undefined || selection.timing !== timing) return undefined;
    const committedHead = requireCommittedRevision(this.run(runId), base.ref);
    const executionId = `market-maker-execution:${sha256({ runId, roundId, timing, versionRef: selection.versionRef, accountId: selection.accountId, committedHeadRevisionRef: committedHead.ref })}`;
    const capability = `market-maker-history:${randomUUID()}`;
    this.state.marketMakerHistoryCapabilities[capability] = {
      capability,
      runId,
      makerAccountId: selection.accountId,
      committedHeadRevisionRef: committedHead.ref,
      executionId,
      expiresAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
    };
    try {
      const seed = sha256({ runId, roundId, timing, versionRef: selection.versionRef, accountId: selection.accountId, committedHeadRevisionRef: committedHead.ref });
      const result = await this.market.executeMarketMaker({
        selection,
        roundId,
        seed,
        financialHistory: { endpoint: this.marketMakerHistoryEndpoint, capability },
        priceUnits: unitsForSnapshot(base.snapshot),
      });
      const execution: FinancialMarketMakerExecution = {
        executionId,
        timing,
        trigger: timing,
        roundId,
        versionRef: selection.versionRef,
        accountId: selection.accountId,
        config: clone(selection.config),
        seed,
        committedHeadRevisionRef: committedHead.ref,
        orders: clone(result.orders),
        createdAt: this.now().toISOString(),
      };
      worktree.marketMakerExecutions ??= {};
      worktree.marketMakerExecutions[timing] = execution;
      return execution;
    } finally {
      // The runner has already finished its parent/child RPC exchange. Keep
      // the durable normalized result, never a reusable history credential.
      delete this.state.marketMakerHistoryCapabilities[capability];
    }
  }

  private async authorize(bearerToken: string): Promise<{
    scope: FinancialMcpScope;
    revision: StoredFinancialRevision;
    registration: FinancialMcpPrincipalRegistration;
  }> {
    requireText(bearerToken, "bearerToken");
    const claims = await this.credentialVerifier.verifyBearer(bearerToken);
    requireText(claims.principalId, "credential.principalId");
    requireText(claims.runId, "credential.runId");
    requireText(claims.agentId, "credential.agentId");
    if (claims.audience !== "financial") {
      throw precondition("Financial MCP bearer credential has the wrong audience");
    }
    const run = this.state.runs[claims.runId];
    if (run === undefined) throw precondition("Financial MCP bearer credential references an unknown run");
    if (run.mcp.accessRevokedAt !== undefined) throw precondition("Financial MCP access has been revoked for this run");
    const registration = run.mcp.principals.find((principal) => principal.principalId === claims.principalId);
    if (registration === undefined || registration.agentId !== claims.agentId) {
      throw precondition("Financial MCP bearer principal is not registered for this run and agent");
    }
    const scope = [...run.mcp.activeScopes]
      .filter((candidate) => candidate.principalId === claims.principalId && candidate.agentId === claims.agentId)
      .sort((left, right) => right.expiresAt.localeCompare(left.expiresAt))[0];
    if (scope === undefined || scope.expiresAt <= this.now().toISOString()) throw precondition("Financial MCP scope is inactive or expired");
    const revision = requireRevision(run, scope.readRevisionRef);
    return { scope: clone(scope), revision, registration: clone(registration) };
  }

  private run(runId: string): FinancialRevisionRunState {
    requireText(runId, "runId");
    let run = this.state.runs[runId];
    if (run === undefined) {
      run = { revisions: {}, roundWorkspaces: {}, mcp: { principals: [], activeScopes: [] } };
      this.state.runs[runId] = run;
    }
    return run;
  }

  async refreshFromStore(): Promise<void> {
    await this.serialized(async () => {
      const restored = (await this.store.load()) ?? emptyFinancialRevisionState();
      validateState(restored);
      markLegacyMcpPrincipals(restored);
      this.state = restored;
    });
  }

  private async mutate<Result>(operation: () => Promise<Result> | Result, refresh = false): Promise<Result> {
    return this.serialized(async () => {
      try {
        if (refresh) {
          const restored = (await this.store.load()) ?? emptyFinancialRevisionState();
          validateState(restored);
          markLegacyMcpPrincipals(restored);
          this.state = restored;
        }
        const result = await operation();
        await this.store.save(this.state);
        return clone(result);
      } catch (error) {
        const restored = (await this.store.load()) ?? emptyFinancialRevisionState();
        validateState(restored);
        markLegacyMcpPrincipals(restored);
        this.state = restored;
        throw error;
      }
    });
  }

  private async serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function makeRevision(input: {
  runId: string;
  roundId: number;
  kind: StoredFinancialRevision["kind"];
  snapshot: FinancialRevisionSnapshot;
  parentRevisionRef?: string;
  sourceManifestRef?: string;
  now: Date;
}): StoredFinancialRevision {
  const digest = sha256({
    context: "financial_market",
    runId: input.runId,
    roundId: input.roundId,
    kind: input.kind,
    snapshot: input.snapshot,
    ...(input.parentRevisionRef === undefined ? {} : { parentRevisionRef: input.parentRevisionRef }),
    ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
  });
  return {
    ref: `revision:financial_market:${input.runId}:${digest}`,
    context: "financial_market",
    runId: input.runId,
    roundId: input.roundId,
    digest,
    ...(input.parentRevisionRef === undefined ? {} : { parentRevisionRef: input.parentRevisionRef }),
    ...(input.sourceManifestRef === undefined ? {} : { sourceManifestRef: input.sourceManifestRef }),
    kind: input.kind,
    snapshot: clone(input.snapshot),
    createdAt: input.now.toISOString(),
  };
}

function publicRevision(revision: StoredFinancialRevision): FinancialContextRevision {
  const { kind: _kind, snapshot: _snapshot, createdAt: _createdAt, ...value } = revision;
  return clone(value);
}

function requireRevision(run: FinancialRevisionRunState, revisionRef: string): StoredFinancialRevision {
  const revision = run.revisions[revisionRef];
  if (revision === undefined) throw notFound(`unknown Financial revision: ${revisionRef}`);
  return revision;
}

function requireCommittedRevision(run: FinancialRevisionRunState, revisionRef: string): StoredFinancialRevision {
  requireCommittedRevisionRef(run, revisionRef);
  return requireRevision(run, revisionRef);
}

function requireCommittedRevisionRef(run: FinancialRevisionRunState, revisionRef: string): void {
  let cursorRef = run.revisionHeadRef;
  const visited = new Set<string>();
  while (cursorRef !== undefined && !visited.has(cursorRef)) {
    visited.add(cursorRef);
    const cursor = requireRevision(run, cursorRef);
    if (cursor.ref === revisionRef) return;
    cursorRef = cursor.parentRevisionRef;
  }
  throw precondition("only committed Financial revisions are queryable");
}

function isCommittedRevision(run: FinancialRevisionRunState, revisionRef: string): boolean {
  try {
    requireCommittedRevision(run, revisionRef);
    return true;
  } catch {
    return false;
  }
}

function requireWorktree(run: FinancialRevisionRunState, roundId: number): FinancialRoundWorkspace {
  requireRound(roundId);
  const worktree = run.roundWorkspaces[String(roundId)];
  if (worktree === undefined) throw notFound(`unknown Financial worktree for round ${roundId}`);
  return worktree;
}

function appliedIntents(worktree: FinancialRoundWorkspace): FinancialIntentRecord[] {
  return orderedIntents(worktree).filter((intent) => intent.status === "applied");
}

function orderedIntents(worktree: FinancialRoundWorkspace): FinancialIntentRecord[] {
  return Object.values(worktree.intents).sort((left, right) => {
    const leftStream = left.streamId ?? worktree.outbox[left.commandId]?.publishedStreamId;
    const rightStream = right.streamId ?? worktree.outbox[right.commandId]?.publishedStreamId;
    if (leftStream !== undefined && rightStream !== undefined) {
      return compareStreamId(leftStream, rightStream) || left.commandId.localeCompare(right.commandId);
    }
    if (leftStream !== undefined) return -1;
    if (rightStream !== undefined) return 1;
    return left.createdAt.localeCompare(right.createdAt) || left.commandId.localeCompare(right.commandId);
  });
}

function compareIntentStream(left: FinancialIntentRecord, right: FinancialIntentRecord): number {
  if (left.streamId === undefined && right.streamId === undefined) return left.commandId.localeCompare(right.commandId);
  if (left.streamId === undefined) return 1;
  if (right.streamId === undefined) return -1;
  return compareStreamId(left.streamId, right.streamId) || left.commandId.localeCompare(right.commandId);
}

/** Redis IDs are numeric pairs, not lexical strings (`10-0` follows `2-0`). */
export function compareStreamId(left: string, right: string): number {
  const leftParts = parseStreamId(left);
  const rightParts = parseStreamId(right);
  return leftParts[0] - rightParts[0] || leftParts[1] - rightParts[1];
}

function parseStreamId(value: string): [number, number] {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw invalid("Redis Stream ID must be <milliseconds>-<sequence>", "streamId");
  const milliseconds = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(milliseconds) || !Number.isSafeInteger(sequence)) {
    throw invalid("Redis Stream ID exceeds safe integer range", "streamId");
  }
  return [milliseconds, sequence];
}

function revisionUri(revisionRef: string): string {
  return `financial://revision/${encodeURIComponent(revisionRef)}`;
}

function parseRevisionUri(uri: string): {
  revisionRef: string;
  kind: "market" | "orders" | "account";
  accountId?: string;
  cursor?: number;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw invalid("Financial MCP resource URI is invalid", "uri");
  }
  if (parsed.protocol !== "financial:" || parsed.hostname !== "revision") {
    throw precondition("Financial MCP resource URI is outside this Context");
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const cursor = parsed.searchParams.has("cursor")
    ? parsePageCursor(parsed.searchParams.get("cursor"), "uri.cursor")
    : undefined;
  if ([...parsed.searchParams.keys()].some((key) => key !== "cursor")) {
    throw invalid("Financial MCP resource URI has unknown query parameters", "uri");
  }
  if (parts.length === 2 && parts[1] === "market") return { revisionRef: parts[0]!, kind: "market", ...(cursor === undefined ? {} : { cursor }) };
  if (parts.length === 2 && parts[1] === "orders") return { revisionRef: parts[0]!, kind: "orders", ...(cursor === undefined ? {} : { cursor }) };
  if (parts.length === 3 && parts[1] === "accounts" && cursor === undefined) return { revisionRef: parts[0]!, kind: "account", accountId: parts[2]! };
  throw invalid("Financial MCP resource URI is unknown", "uri");
}

function resourceCapability(kind: "market" | "orders" | "account"): FinancialMcpResourceId {
  if (kind === "market") return "financial.market";
  if (kind === "orders") return "financial.orders";
  return "financial.account";
}

function permitsTool(registration: FinancialMcpPrincipalRegistration, capability: FinancialMcpToolId): boolean {
  return (registration.legacyFullAccess === true && (capability === "financial.place_order" || capability === "financial.cancel_order"))
    || registration.permissions?.tools.includes(capability) === true;
}

function permitsResource(registration: FinancialMcpPrincipalRegistration, capability: FinancialMcpResourceId): boolean {
  return registration.legacyFullAccess === true || registration.permissions?.resources.includes(capability) === true;
}

function assertToolAllowed(registration: FinancialMcpPrincipalRegistration, capability: FinancialMcpToolId): void {
  if (!permitsTool(registration, capability)) {
    throw precondition(`Financial MCP tool ${capability} is not allowed by the active MCP Policy`);
  }
}

function requireBoundAccount(scope: FinancialMcpScope): string {
  if (scope.accountId === undefined) throw precondition("Financial MCP principal has no trading account");
  return scope.accountId;
}

function assertResourceAllowed(registration: FinancialMcpPrincipalRegistration, capability: FinancialMcpResourceId): void {
  if (!permitsResource(registration, capability)) {
    throw precondition(`Financial MCP resource ${capability} is not allowed by the active MCP Policy`);
  }
}

function samePermissions(registration: FinancialMcpPrincipalRegistration, permissions: FinancialMcpPermissions): boolean {
  if (registration.legacyFullAccess === true || registration.permissions === undefined) return false;
  return sameStringSet(registration.permissions.tools, permissions.tools)
    && sameStringSet(registration.permissions.resources, permissions.resources);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function marketResource(snapshot: FinancialRevisionSnapshot, revision: StoredFinancialRevision, cursor = 0): {
  revision: FinancialContextRevision;
  tickSize: number;
  summary: MarketSummary;
  trades: Trade[];
  nextUri?: string;
} {
  const open = snapshot.orders.filter((order) => order.status === "open");
  const bids = open.filter((order) => order.side === "buy" && order.limitPrice !== undefined).map((order) => order.limitPrice!);
  const asks = open.filter((order) => order.side === "sell" && order.limitPrice !== undefined).map((order) => order.limitPrice!);
  const trades = [...snapshot.trades].reverse();
  const page = trades.slice(cursor, cursor + FINANCIAL_RESOURCE_PAGE_SIZE);
  return {
    revision: publicRevision(revision),
    tickSize: tickSizeFor(snapshot),
    summary: {
      roundId: revision.roundId,
      lastTradePrice: publicMoney(snapshot.trades.at(-1)?.price ?? snapshot.referencePrice, snapshot),
      volume: snapshot.trades.filter((trade) => trade.roundId === revision.roundId).reduce((total, trade) => total + trade.quantity, 0),
      bestBid: publicMoney(bids.length === 0 ? 0 : Math.max(...bids), snapshot),
      bestAsk: publicMoney(asks.length === 0 ? 0 : Math.min(...asks), snapshot),
      openOrderCount: open.length,
    },
    trades: page.map((trade) => publicTrade(trade, snapshot)),
    ...(cursor + page.length < trades.length
      ? { nextUri: paginatedRevisionUri(revision.ref, "market", cursor + page.length) }
      : {}),
  };
}

function orderResource(
  snapshot: FinancialRevisionSnapshot,
  revisionRef: string,
  accountId: string,
  cursor = 0,
): { tickSize: number; orders: Order[]; nextUri?: string } {
  const orders = snapshot.orders
    .filter((order) => order.accountId === accountId)
    .sort((left, right) => right.createdSequence - left.createdSequence);
  const page = orders.slice(cursor, cursor + FINANCIAL_RESOURCE_PAGE_SIZE);
  return {
    tickSize: tickSizeFor(snapshot),
    orders: page.map((order) => publicOrder(order, snapshot)),
    ...(cursor + page.length < orders.length
      ? { nextUri: paginatedRevisionUri(revisionRef, "orders", cursor + page.length) }
      : {}),
  };
}

function paginatedRevisionUri(revisionRef: string, kind: "market" | "orders", cursor: number): string {
  const uri = new URL(`${revisionUri(revisionRef)}/${kind}`);
  uri.searchParams.set("cursor", String(cursor));
  return uri.toString();
}

async function committedHistoryRecords(
  service: FinancialRevisionService,
  _runId: string,
  headRevisionRef: string,
  makerAccountId?: string,
): Promise<Array<{
  roundId: number;
  tickSize: number;
  referencePrice: number;
  openingReferencePrice: number;
  summary: MarketSummary;
  trades: Array<{ roundId: number; price: number; quantity: number; makerSide: "buy" | "sell" | null }>;
  bidDepth: Array<{ price: number; quantity: number }>;
  askDepth: Array<{ price: number; quantity: number }>;
}>> {
  const lineage: StoredFinancialRevision[] = [];
  const seen = new Set<string>();
  let cursor: StoredFinancialRevision | undefined = await service.loadRevision(headRevisionRef);
  while (cursor !== undefined && !seen.has(cursor.ref)) {
    seen.add(cursor.ref);
    lineage.push(cursor);
    cursor = cursor.parentRevisionRef === undefined ? undefined : await service.loadRevision(cursor.parentRevisionRef);
  }
  const byRound = new Map<number, ReturnType<typeof historyRecord>>();
  let previousSnapshot: FinancialRevisionSnapshot | undefined;
  for (const revision of lineage.reverse()) {
    const existing = byRound.get(revision.roundId);
    const openingReferencePrice = existing?.openingReferencePrice
      ?? marketReferencePrice(previousSnapshot ?? revision.snapshot);
    byRound.set(revision.roundId, historyRecord(revision, openingReferencePrice, makerAccountId));
    previousSnapshot = revision.snapshot;
  }
  return [...byRound.values()].sort((left, right) => left.roundId - right.roundId);
}

function historyRecord(
  revision: StoredFinancialRevision,
  openingReferencePrice: number,
  makerAccountId?: string,
): {
  roundId: number;
  tickSize: number;
  referencePrice: number;
  openingReferencePrice: number;
  summary: MarketSummary;
  trades: Array<{ roundId: number; price: number; quantity: number; makerSide: "buy" | "sell" | null }>;
  bidDepth: Array<{ price: number; quantity: number }>;
  askDepth: Array<{ price: number; quantity: number }>;
} {
  const snapshot = revision.snapshot;
  const orders = new Map(snapshot.orders.map((order) => [order.orderId, order]));
  const open = snapshot.orders.filter((order) => order.status === "open");
  const depth = (side: "buy" | "sell") => {
    const quantities = new Map<number, number>();
    for (const order of open) {
      if (order.side !== side) continue;
      if (order.limitPrice === undefined) continue;
      quantities.set(order.limitPrice, (quantities.get(order.limitPrice) ?? 0) + order.remaining);
    }
    return [...quantities.entries()]
      .map(([price, quantity]) => ({ price, quantity }))
      .sort((left, right) => side === "buy" ? right.price - left.price : left.price - right.price);
  };
  const bids = depth("buy");
  const asks = depth("sell");
  return {
    roundId: revision.roundId,
    tickSize: tickSizeFor(snapshot),
    referencePrice: publicMoney(snapshot.referencePrice, snapshot),
    openingReferencePrice: publicMoney(openingReferencePrice, snapshot),
    summary: {
      roundId: revision.roundId,
      lastTradePrice: publicMoney(snapshot.trades.at(-1)?.price ?? snapshot.referencePrice, snapshot),
      volume: snapshot.trades.filter((trade) => trade.roundId === revision.roundId).reduce((total, trade) => total + trade.quantity, 0),
      bestBid: publicMoney(bids[0]?.price ?? 0, snapshot),
      bestAsk: publicMoney(asks[0]?.price ?? 0, snapshot),
      openOrderCount: open.length,
    },
    trades: snapshot.trades
      .filter((trade) => trade.roundId === revision.roundId)
      .map((trade) => {
        const buy = orders.get(trade.buyOrderId);
        const sell = orders.get(trade.sellOrderId);
        const makerSide = makerAccountId !== undefined && buy?.accountId === makerAccountId
          ? "buy" as const
          : makerAccountId !== undefined && sell?.accountId === makerAccountId
            ? "sell" as const
            : null;
        return { roundId: trade.roundId, price: publicMoney(trade.price, snapshot), quantity: trade.quantity, makerSide };
      }),
    bidDepth: bids.map((level) => ({ ...level, price: publicMoney(level.price, snapshot) })),
    askDepth: asks.map((level) => ({ ...level, price: publicMoney(level.price, snapshot) })),
  };
}

async function initialRevisionForRun(
  service: FinancialRevisionService,
  runId: string,
  headRevisionRef: string,
): Promise<StoredFinancialRevision> {
  let cursor = await service.loadRevision(headRevisionRef);
  let initial = cursor;
  const seen = new Set<string>();
  while (!seen.has(cursor.ref)) {
    seen.add(cursor.ref);
    if (cursor.runId === runId) initial = cursor;
    if (cursor.parentRevisionRef === undefined) break;
    cursor = await service.loadRevision(cursor.parentRevisionRef);
  }
  return initial;
}

function marketReferencePrice(snapshot: FinancialRevisionSnapshot): number {
  const open = snapshot.orders.filter((order) => order.status === "open" && order.limitPrice !== undefined);
  const bids = open.filter((order) => order.side === "buy").map((order) => order.limitPrice!);
  const asks = open.filter((order) => order.side === "sell").map((order) => order.limitPrice!);
  if (bids.length > 0 && asks.length > 0) return Math.max(1, Math.round((Math.max(...bids) + Math.min(...asks)) / 2));
  return Math.max(1, snapshot.trades.at(-1)?.price ?? snapshot.referencePrice);
}

function quote(snapshot: FinancialRevisionSnapshot): {
  symbol: string;
  tickSize: number;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
} {
  const book = orderBook(snapshot, 1);
  return {
    symbol: snapshot.symbol ?? "ASSET",
    tickSize: tickSizeFor(snapshot),
    lastPrice: publicMoney(snapshot.trades.at(-1)?.price ?? snapshot.referencePrice, snapshot),
    bestBid: book.bids[0]?.price ?? 0,
    bestAsk: book.asks[0]?.price ?? 0,
    bidSize: book.bids[0]?.quantity ?? 0,
    askSize: book.asks[0]?.quantity ?? 0,
  };
}

function orderBook(snapshot: FinancialRevisionSnapshot, depth: number): {
  symbol: string;
  bids: Array<{ price: number; quantity: number; orderCount: number }>;
  asks: Array<{ price: number; quantity: number; orderCount: number }>;
} {
  const levels = (side: "buy" | "sell") => {
    const values = new Map<number, { quantity: number; orderCount: number }>();
    for (const order of snapshot.orders) {
      if (order.status !== "open" || order.side !== side || (order.orderType ?? "limit") !== "limit" || order.limitPrice === undefined) continue;
      const current = values.get(order.limitPrice) ?? { quantity: 0, orderCount: 0 };
      current.quantity += order.remaining;
      current.orderCount += 1;
      values.set(order.limitPrice, current);
    }
    return [...values.entries()]
      .map(([price, value]) => ({ price: publicMoney(price, snapshot), ...value }))
      .sort((left, right) => side === "buy" ? right.price - left.price : left.price - right.price)
      .slice(0, depth);
  };
  return { symbol: snapshot.symbol ?? "ASSET", bids: levels("buy"), asks: levels("sell") };
}

function publicOpenOrders(snapshot: FinancialRevisionSnapshot): Array<{
  orderSequence: number;
  side: "buy" | "sell";
  limitPrice: number;
  quantity: number;
  remainingQuantity: number;
  timeInForce: string;
  expiresAtRound?: number;
}> {
  return snapshot.orders
    .filter((order) =>
      order.status === "open"
      && (order.orderType ?? "limit") === "limit"
      && order.limitPrice !== undefined)
    .sort((left, right) => left.createdSequence - right.createdSequence)
    .map((order) => ({
      orderSequence: order.createdSequence,
      side: order.side,
      limitPrice: publicMoney(order.limitPrice!, snapshot),
      quantity: order.quantity,
      remainingQuantity: order.remaining,
      timeInForce: order.timeInForce,
      ...(order.expiresAtRound === undefined ? {} : { expiresAtRound: order.expiresAtRound }),
    }));
}

async function candlesFromLineage(service: FinancialRevisionService, revisionRef: string): Promise<Array<{
  roundId: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>> {
  const revision = await service.loadRevision(revisionRef);
  const records = await committedHistoryRecords(service, revision.runId, revisionRef);
  let previousClose = records[0]?.referencePrice ?? 0;
  return records.map((record) => {
    const prices = record.trades.map((trade) => trade.price);
    const open = prices[0] ?? previousClose;
    const close = prices.at(-1) ?? previousClose;
    const candle = {
      roundId: record.roundId,
      open,
      high: prices.length === 0 ? previousClose : Math.max(...prices),
      low: prices.length === 0 ? previousClose : Math.min(...prices),
      close,
      volume: record.trades.reduce((total, trade) => total + trade.quantity, 0),
    };
    previousClose = close;
    return candle;
  });
}

function resolveSizing(
  snapshot: FinancialRevisionSnapshot,
  accountId: string,
  side: "buy" | "sell",
  input: { quantity?: unknown; cashAmount?: unknown; fraction?: unknown },
  limitPrice?: number,
): { quantity: number; cashBudget?: number } {
  const supplied = [input.quantity, input.cashAmount, input.fraction].filter((value) => value !== undefined);
  if (supplied.length !== 1) throw invalid("exactly one of quantity, cashAmount, or fraction is required", "sizing");
  const account = requireSnapshotAccount(snapshot, accountId);
  const availableCash = account.cash - account.reservedCash;
  const availablePosition = account.position - account.reservedPosition;
  if (input.quantity !== undefined) return { quantity: positiveIntegerValue(input.quantity, "quantity") };
  const reference = limitPrice ?? (side === "buy" ? quote(snapshot).bestAsk : quote(snapshot).bestBid);
  if (reference < 1) throw precondition(`cannot size ${side} order without executable market price`);
  if (input.cashAmount !== undefined) {
    const cashAmount = positiveIntegerValue(input.cashAmount, "cashAmount");
    const quantity = Math.floor(cashAmount / reference);
    if (quantity < 1) throw invalid("cashAmount is too small for one unit", "cashAmount");
    return { quantity, ...(side === "buy" ? { cashBudget: cashAmount } : {}) };
  }
  const fraction = Number(input.fraction);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw invalid("fraction must be greater than 0 and at most 1", "fraction");
  if (side === "buy") {
    const cashBudget = Math.floor(availableCash * fraction);
    const quantity = Math.floor(cashBudget / reference);
    if (quantity < 1) throw invalid("fraction is too small for one unit", "fraction");
    return { quantity, cashBudget };
  }
  const quantity = Math.floor(availablePosition * fraction);
  if (quantity < 1) throw invalid("fraction is too small for one unit", "fraction");
  return { quantity };
}

function preview(
  snapshot: FinancialRevisionSnapshot,
  accountId: string,
  side: "buy" | "sell",
  requestedQuantity: number,
  orderType: "limit" | "market",
  limitPrice?: number,
  cashBudget?: number,
): {
  nonBinding: true;
  requestedQuantity: number;
  estimatedFilledQuantity: number;
  estimatedNotional: number;
  averagePrice: number | null;
  remainingQuantity: number;
  sufficientFunds: boolean;
} {
  const account = requireSnapshotAccount(snapshot, accountId);
  let remaining = requestedQuantity;
  let notional = 0;
  const orders = snapshot.orders
    .filter((order) =>
      order.status === "open"
      && (order.orderType ?? "limit") === "limit"
      && order.limitPrice !== undefined
      && order.side !== side
      && order.accountId !== accountId
      && (orderType === "market" || (side === "buy" ? order.limitPrice <= limitPrice! : order.limitPrice >= limitPrice!)))
    .sort(side === "buy"
      ? (left, right) => left.limitPrice! - right.limitPrice! || left.createdSequence - right.createdSequence
      : (left, right) => right.limitPrice! - left.limitPrice! || left.createdSequence - right.createdSequence);
  for (const order of orders) {
    let quantity = Math.min(remaining, order.remaining);
    if (side === "buy") {
      const budget = Math.min(account.cash - account.reservedCash, cashBudget ?? Number.MAX_SAFE_INTEGER) - notional;
      quantity = Math.min(quantity, Math.floor(budget / order.limitPrice!));
    }
    if (quantity < 1) break;
    remaining -= quantity;
    notional += quantity * order.limitPrice!;
    if (remaining === 0) break;
  }
  const filled = requestedQuantity - remaining;
  const sufficientFunds = side === "sell"
    ? account.position - account.reservedPosition >= requestedQuantity
    : orderType === "limit"
      ? account.cash - account.reservedCash >= requestedQuantity * limitPrice!
      : (cashBudget ?? account.cash - account.reservedCash) >= notional;
  return {
    nonBinding: true,
    requestedQuantity,
    estimatedFilledQuantity: filled,
    estimatedNotional: notional,
    averagePrice: filled === 0 ? null : notional / filled,
    remainingQuantity: remaining,
    sufficientFunds,
  };
}

function requireSnapshotAccount(snapshot: FinancialRevisionSnapshot, accountId: string) {
  const account = snapshot.accounts.find((candidate) => candidate.accountId === accountId);
  if (account === undefined) throw notFound(`unknown Financial account: ${accountId}`);
  return clone(account);
}

function publicMoney(value: number, snapshot: FinancialRevisionSnapshot): number {
  return unitsToDecimal(value, unitsForSnapshot(snapshot).priceScale);
}

function marketMakerReplacementAvailability(snapshot: FinancialRevisionSnapshot, accountId: string): {
  cash: number;
  position: number;
} {
  const account = snapshot.accounts.find((candidate) => candidate.accountId === accountId);
  if (account === undefined) throw notFound(`unknown Financial account: ${accountId}`);
  let replaceableReservedCash = 0;
  let replaceableReservedPosition = 0;
  for (const order of snapshot.orders) {
    if (order.accountId !== accountId || order.origin !== "market_maker" || order.status !== "open") continue;
    if (order.side === "buy") {
      if (order.limitPrice === undefined) throw new Error(`open Market Maker buy order has no limit price: ${order.orderId}`);
      replaceableReservedCash += order.remaining * order.limitPrice;
    } else {
      replaceableReservedPosition += order.remaining;
    }
  }
  if (replaceableReservedCash > account.reservedCash || replaceableReservedPosition > account.reservedPosition) {
    throw new Error(`Market Maker reservations exceed account reservations: ${accountId}`);
  }
  return {
    cash: account.cash - (account.reservedCash - replaceableReservedCash),
    position: account.position - (account.reservedPosition - replaceableReservedPosition),
  };
}

function publicMoneyDelta(current: number, previous: number, snapshot: FinancialRevisionSnapshot): number {
  return decimalDelta(current, previous, unitsForSnapshot(snapshot).priceScale);
}

function publicAccount<T extends { cash: number; reservedCash: number }>(account: T, snapshot: FinancialRevisionSnapshot): T {
  return { ...clone(account), cash: publicMoney(account.cash, snapshot), reservedCash: publicMoney(account.reservedCash, snapshot) };
}

function publicOrder(order: Order, snapshot: FinancialRevisionSnapshot): Order {
  return {
    ...clone(order),
    ...(order.limitPrice === undefined ? {} : { limitPrice: publicMoney(order.limitPrice, snapshot) }),
    ...(order.cashBudget === undefined ? {} : { cashBudget: publicMoney(order.cashBudget, snapshot) }),
  };
}

function publicTrade(trade: Trade, snapshot: FinancialRevisionSnapshot): Trade {
  return { ...clone(trade), price: publicMoney(trade.price, snapshot) };
}

function publicIntent(intent: FinancialIntentRecord, snapshot: FinancialRevisionSnapshot): FinancialIntentRecord {
  const action = clone(intent.action);
  if (action.type === "submitOrder" || action.type === "replaceOrder") {
    action.limitPrice = publicMoney(action.limitPrice, snapshot);
  } else if (action.type === "submitMarketOrder" && action.cashBudget !== undefined) {
    action.cashBudget = publicMoney(action.cashBudget, snapshot);
  }
  return { ...clone(intent), action };
}

function publicSizingToUnits(
  input: { quantity?: unknown; cashAmount?: unknown; fraction?: unknown },
  units: ReturnType<typeof unitsForSnapshot>,
): { quantity?: unknown; cashAmount?: unknown; fraction?: unknown } {
  return {
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.cashAmount === undefined ? {} : { cashAmount: cashToUnits(positiveNumberValue(input.cashAmount, "cashAmount"), units, "cashAmount") }),
    ...(input.fraction === undefined ? {} : { fraction: input.fraction }),
  };
}

function publicPreview<T extends { estimatedNotional: number; averagePrice: number | null }>(value: T, snapshot: FinancialRevisionSnapshot): T {
  return {
    ...value,
    estimatedNotional: publicMoney(value.estimatedNotional, snapshot),
    averagePrice: value.averagePrice === null ? null : publicMoney(value.averagePrice, snapshot),
  };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${field} must be an integer from ${minimum} to ${maximum}`, field);
  }
  return value as number;
}

function parsePageCursor(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalid(`${field} must be a non-negative integer cursor`, field);
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw invalid(`${field} must be a non-negative integer cursor`, field);
  }
  return offset;
}

function positiveIntegerValue(value: unknown, field: string): number {
  return boundedInteger(value, 0, 1, Number.MAX_SAFE_INTEGER, field);
}

function positiveNumberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(`${field} must be a finite positive number`, field);
  }
  return value;
}

function optionalInteger(value: unknown, minimum: number, maximum: number, field: string): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, minimum, minimum, maximum, field);
}

function requireTextValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} must be a non-empty string`, field);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function brokerSide(value: unknown): "buy" | "sell" {
  if (value !== "buy" && value !== "sell") throw invalid("side must be buy or sell", "side");
  return value;
}

function parseHistoryCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw invalid("market maker history cursor is invalid", "cursor");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid("market maker history cursor is invalid", "cursor");
  return parsed;
}

function validateState(state: FinancialRevisionState): void {
  if (
    state.version !== 2 ||
    typeof state.runs !== "object" ||
    state.runs === null ||
    typeof state.marketMakerHistoryCapabilities !== "object" ||
    state.marketMakerHistoryCapabilities === null
  ) {
    throw invalid("Financial revision state is invalid");
  }
  for (const [runId, run] of Object.entries(state.runs)) {
    if (
      !run ||
      typeof run.revisions !== "object" ||
      typeof run.roundWorkspaces !== "object" ||
      !run.mcp ||
      !Array.isArray(run.mcp.principals) ||
      !Array.isArray(run.mcp.activeScopes)
    ) {
      throw invalid(`Financial revision state is invalid for run ${runId}`);
    }
    for (const principal of run.mcp.principals) {
      const parsedPermissions = principal?.permissions === undefined
        ? undefined
        : financialMcpPermissionsSchema.safeParse(principal.permissions);
      const accountlessPolicyIsInvalid = principal?.accountId === undefined && (
        parsedPermissions === undefined ||
        !parsedPermissions.success ||
        parsedPermissions.data.tools.some((tool) => !MARKET_READ_TOOLS.has(tool)) ||
        parsedPermissions.data.resources.some((resource) => resource !== "financial.market") ||
        principal.legacyFullAccess === true
      );
      if (
        !principal ||
        typeof principal.agentId !== "string" ||
        typeof principal.principalId !== "string" ||
        (principal.accountId !== undefined && typeof principal.accountId !== "string") ||
        (principal.legacyFullAccess !== undefined && principal.legacyFullAccess !== true) ||
        (parsedPermissions !== undefined && !parsedPermissions.success) ||
        (principal.permissions !== undefined && principal.legacyFullAccess === true) ||
        accountlessPolicyIsInvalid
      ) {
        throw invalid(`Financial MCP principal state is invalid for run ${runId}`);
      }
    }
  }
}

function markLegacyMcpPrincipals(state: FinancialRevisionState): void {
  for (const run of Object.values(state.runs)) {
    for (const principal of run.mcp.principals) {
      if (principal.permissions === undefined) principal.legacyFullAccess = true;
    }
  }
}

const unavailableCredentialVerifier: FinancialMcpCredentialVerifier = {
  async verifyBearer(): Promise<FinancialMcpCredentialClaims> {
    throw precondition("Financial MCP bearer verifier is not configured");
  },
};


function requireText(value: string, field: string): void {
  if (!value.trim()) throw invalid(`${field} must not be empty`, field);
}

function requireRound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid("roundId must be a positive safe integer", "roundId");
}

function requireSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${field} must be a positive safe integer`, field);
}
