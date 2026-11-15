"use client";

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { runActionMachine, type RunAction } from "./run-action-machine";
import { forkManifestBinding } from "./run-fork-input";
import { ContextPluginSurface } from "./context-plugin-surface";
import { type TurnPromptVariableDefinition, type TurnPromptVariableValue } from "@openleek/contracts/turn-prompt";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type BrowserConsole = {
  console: Record<"run" | "roundProgress" | "audit" | "tokenUsage" | "transcripts" | "committedRounds" | "facts" | "hookPolicy", Procedure>
    & Record<"resume" | "retry" | "cancel" | "fork" | "updateHookPolicy", Procedure>
    & { feedAlgorithms: Record<"list", Procedure>; marketMakers: Record<"list", Procedure>; turnPrompts: Record<"list", Procedure> };
};

type WorkspaceView = "overview" | "evidence" | "usage" | "transcript" | "results" | "fork";
type ResultTab = string;
type MarketMakerForkChoice = "inherit" | "select" | "disable";
type FeedAlgorithmVersion = { versionRef: string; name: string; defaultConfig: Record<string, unknown> };
type MarketMakerVersion = { versionRef: string; name: string; defaultConfig: Record<string, unknown> };
type TurnPromptVersion = { versionRef: string; name: string; variables: TurnPromptVariableDefinition[] };
type Run = {
  runId: string;
  lifecycle: string;
  committedRound: number;
  configuredRounds: number;
  conditionDigest: string;
  committedManifestRef?: string;
  failure?: { category: string; message: string; occurredAt: string };
  advanceRetry?: {
    roundId: number;
    attempts: number;
    maxAttempts: number;
    nextRetryAt: string;
    recentError: { category: string; message: string; occurredAt: string };
  };
};
type Progress = { roundId: number; snapshotDigest: string; attempt: number; state: string; total: number; queued: number; running: number; succeeded: number; failed: number; recentError?: string };
type Manifest = { ref: string; roundId: number; state: string; [key: string]: unknown };
type HookPolicy = { strategyInjectionEnabled: boolean; revision: number; updatedAt: string };

function api(): BrowserConsole { return createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as BrowserConsole; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pretty(value: unknown) { return JSON.stringify(value, null, 2); }
function key() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
function parseObject(value: string, errorMessage: string): Record<string, unknown> { const parsed = JSON.parse(value) as unknown; if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(errorMessage); return parsed as Record<string, unknown>; }

function manifests(value: unknown): Manifest[] {
  const items = record(value).items;
  return Array.isArray(items) ? items.filter((item): item is Manifest => {
    const candidate = record(item);
    return typeof candidate.ref === "string" && typeof candidate.roundId === "number" && typeof candidate.state === "string";
  }) : [];
}
function feedVersions(value: unknown): FeedAlgorithmVersion[] { const versions = record(value).versions; return Array.isArray(versions) ? versions.filter((item): item is FeedAlgorithmVersion => typeof record(item).versionRef === "string" && typeof record(item).name === "string") : []; }
function marketMakerVersions(value: unknown): MarketMakerVersion[] { const versions = record(value).versions; return Array.isArray(versions) ? versions.filter((item): item is MarketMakerVersion => typeof record(item).versionRef === "string" && typeof record(item).name === "string") : []; }
function turnPromptVersions(value: unknown): TurnPromptVersion[] { const versions = record(value).versions; return Array.isArray(versions) ? versions.filter((item): item is TurnPromptVersion => typeof record(item).versionRef === "string" && typeof record(item).name === "string" && Array.isArray(record(item).variables)) : []; }
function lifecycleAction(lifecycle: string, action: Exclude<RunAction, "fork">) { if (action === "resume") return lifecycle === "queued"; if (action === "retry") return lifecycle === "retry_wait"; return ["queued", "initializing", "running", "retry_wait", "cancel_requested"].includes(lifecycle); }

export function RunWorkspace({ runId, view }: { runId: string; view: WorkspaceView }) {
  const t = useTranslations("RunWorkspace");
  const client = useMemo(api, []);
  const [actionState, sendAction] = useMachine(runActionMachine);
  const [run, setRun] = useState<Run>();
  const [progress, setProgress] = useState<Progress>();
  const [hookPolicy, setHookPolicy] = useState<HookPolicy>();
  const [hookPolicySaving, setHookPolicySaving] = useState(false);
  const [audit, setAudit] = useState<unknown>();
  const [tokenUsage, setTokenUsage] = useState<unknown[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, unknown>>({ availability: "available", items: [] });
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [committed, setCommitted] = useState<Manifest[]>([]);
  const [selectedManifestRef, setSelectedManifestRef] = useState("");
  const [facts, setFacts] = useState<Record<string, unknown>>();
  const [resultTab, setResultTab] = useState<ResultTab>("manifest");
  const [status, setStatus] = useState(t("loadingWorkspace"));
  const actionLabel = useCallback((action: RunAction | undefined) => ({ resume: t("resumeRun"), retry: t("retryRun"), cancel: t("cancelRun"), fork: t("createFork") } as Record<RunAction, string>)[action ?? "resume"], [t]);
  const [feedAlgorithmVersions, setFeedAlgorithmVersions] = useState<FeedAlgorithmVersion[]>([]);
  const [marketMakerVersionList, setMarketMakerVersionList] = useState<MarketMakerVersion[]>([]);
  const [turnPromptVersionList, setTurnPromptVersionList] = useState<TurnPromptVersion[]>([]);
  const [turnPromptOverride, setTurnPromptOverride] = useState(false);
  const [turnPromptVersionRef, setTurnPromptVersionRef] = useState("");
  const [turnPromptVariables, setTurnPromptVariables] = useState<Record<string, TurnPromptVariableValue>>({});
  const [feedOverride, setFeedOverride] = useState(false);
  const [feedVersionRef, setFeedVersionRef] = useState("");
  const [feedConfig, setFeedConfig] = useState("{}");
  const [marketMakerChoice, setMarketMakerChoice] = useState<MarketMakerForkChoice>("inherit");
  const [marketMakerVersionRef, setMarketMakerVersionRef] = useState("");
  const [marketMakerPresetVersionRef, setMarketMakerPresetVersionRef] = useState("");
  const [marketMakerTiming, setMarketMakerTiming] = useState<"opening" | "settlement">("opening");
  const [marketMakerMatchingPolicy, setMarketMakerMatchingPolicy] = useState<"batch" | "incremental">("batch");
  const [marketMakerRequotePolicy, setMarketMakerRequotePolicy] = useState<"none" | "after_each_trade">("none");
  const [marketMakerMaxRequotes, setMarketMakerMaxRequotes] = useState(1000);
  const [marketMakerConfig, setMarketMakerConfig] = useState("{}");

  const refreshRun = useCallback(async () => {
    try {
      const response = record(await client.console.run.query({ runId }));
      const next = Object.keys(record(response.status)).length ? record(response.status) : response;
      if (typeof next.runId !== "string") throw new Error(t("couldNotLoadRun"));
      setRun(next as unknown as Run);
    } catch (error) { setStatus(error instanceof Error ? error.message : t("couldNotLoadRun")); }
  }, [client, runId, t]);
  const refreshCommitted = useCallback(async () => {
    try {
      const next = manifests(await client.console.committedRounds.query({ runId, limit: 100 }));
      setCommitted(next);
      setSelectedManifestRef((current) => current && next.some((item) => item.ref === current) ? current : (next.at(-1)?.ref ?? ""));
    } catch (error) { setStatus(error instanceof Error ? error.message : t("couldNotLoadHistory")); }
  }, [client, runId, t]);

  useEffect(() => { void refreshRun(); }, [refreshRun]);
  useEffect(() => { void refreshCommitted(); }, [refreshCommitted]);
  useEffect(() => {
    if (view !== "overview") return;
    let cancelled = false;
    const loadProgress = async () => { try { const next = record(await client.console.roundProgress.query({ runId })); if (!cancelled) setProgress(typeof next.snapshotDigest === "string" ? next as unknown as Progress : undefined); } catch { if (!cancelled) setProgress(undefined); } };
    const loadHookPolicy = async () => { try { const next = record(await client.console.hookPolicy.query({ runId })); if (!cancelled && typeof next.revision === "number") setHookPolicy(next as unknown as HookPolicy); } catch (error) { if (!cancelled) setStatus(error instanceof Error ? error.message : t("couldNotLoadHookPolicy")); } };
    void loadProgress(); void loadHookPolicy(); const timer = setInterval(() => void loadProgress(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, runId, t, view]);
  useEffect(() => {
    if (view !== "evidence") return;
    let cancelled = false;
    void client.console.audit.query({ runId }).then((next) => { if (!cancelled) setAudit(next); }).catch((error: unknown) => { if (!cancelled) setStatus(error instanceof Error ? error.message : t("couldNotLoadAudit")); });
    return () => { cancelled = true; };
  }, [client, runId, t, view]);
  useEffect(() => {
    if (view !== "usage") return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await client.console.tokenUsage.query({ runId });
        if (!cancelled) {
          setTokenUsage(Array.isArray(next) ? next : []);
          setStatus(t("showingUsage"));
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : t("couldNotLoadUsage"));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, runId, t, view]);
  useEffect(() => {
    if (view !== "transcript") return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = record(await client.console.transcripts.query({ runId, limit: 50 }));
        if (!cancelled) { setTranscripts(next); setStatus(t("showingTranscript")); }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : t("couldNotLoadTranscript"));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [client, runId, t, view]);
  const loadMoreTranscripts = useCallback(async () => {
    const cursor = transcripts.nextCursor;
    if (typeof cursor !== "string" || transcriptLoading) return;
    setTranscriptLoading(true);
    try {
      const next = record(await client.console.transcripts.query({ runId, cursor, limit: 50 }));
      setTranscripts((current) => ({ ...next, items: [...(Array.isArray(current.items) ? current.items : []), ...(Array.isArray(next.items) ? next.items : [])] }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("couldNotLoadTranscript"));
    } finally {
      setTranscriptLoading(false);
    }
  }, [client, runId, t, transcriptLoading, transcripts.nextCursor]);
  useEffect(() => {
    if (view !== "results" || !selectedManifestRef) { setFacts(undefined); return; }
    let cancelled = false; setStatus(t("loadingFacts"));
    void client.console.facts.query({ runId, manifestRef: selectedManifestRef, limit: 50 }).then((next) => { if (!cancelled) { setFacts(record(next)); setStatus(t("showingFacts")); } }).catch((error: unknown) => { if (!cancelled) setStatus(error instanceof Error ? error.message : t("loadingFacts")); });
    return () => { cancelled = true; };
  }, [client, runId, selectedManifestRef, t, view]);
  useEffect(() => {
    if (view !== "fork") return;
    let cancelled = false;
    void Promise.all([client.console.feedAlgorithms.list.query({}), client.console.marketMakers.list.query({}), client.console.turnPrompts.list.query({})]).then(([feed, market, prompts]) => { if (!cancelled) { setFeedAlgorithmVersions(feedVersions(feed)); setMarketMakerVersionList(marketMakerVersions(market)); setTurnPromptVersionList(turnPromptVersions(prompts)); } }).catch((error: unknown) => { if (!cancelled) setStatus(error instanceof Error ? error.message : t("couldNotLoadOverrides")); });
    return () => { cancelled = true; };
  }, [client, t, view]);

  const executeAction = useCallback(async (action: RunAction) => {
    if (!run) throw new Error(t("runNotLoaded"));
    if (action === "fork") {
      if (!selectedManifestRef) throw new Error(t("chooseManifest"));
      let feedAlgorithm: { versionRef: string; config: Record<string, unknown> } | undefined;
      if (feedOverride) { if (!feedVersionRef) throw new Error(t("chooseFeed")); feedAlgorithm = { versionRef: feedVersionRef, config: parseObject(feedConfig, t("feedConfigError")) }; }
      let marketMaker: { versionRef: string; initialStatePresetVersionRef: string; timing: "opening" | "settlement"; matchingPolicy: "batch" | "incremental"; requotePolicy: "none" | "after_each_trade"; maxRequotesPerIntent: number; config: Record<string, unknown> } | null | undefined;
      if (marketMakerChoice === "disable") marketMaker = null;
      if (marketMakerChoice === "select") { if (!marketMakerVersionRef) throw new Error(t("chooseMaker")); if (!marketMakerPresetVersionRef.trim()) throw new Error(t("enterMakerPreset")); marketMaker = { versionRef: marketMakerVersionRef, initialStatePresetVersionRef: marketMakerPresetVersionRef.trim(), timing: marketMakerTiming, matchingPolicy: marketMakerMatchingPolicy, requotePolicy: marketMakerRequotePolicy, maxRequotesPerIntent: marketMakerMaxRequotes, config: parseObject(marketMakerConfig, t("makerConfigError")) }; }
      const turnPrompt = turnPromptOverride ? { versionRef: turnPromptVersionRef, variables: turnPromptVariables } : undefined;
      if (turnPromptOverride && !turnPromptVersionRef) throw new Error(t("chooseTurnPrompt"));
      const result = record(await client.console.fork.mutate({ runId, ...forkManifestBinding(selectedManifestRef), idempotencyKey: key(), ...(feedAlgorithm ? { feedAlgorithm } : {}), ...(marketMaker === undefined ? {} : { marketMaker }), ...(turnPrompt === undefined ? {} : { turnPrompt }) }));
      return typeof result.runId === "string" ? t("forkCreated", { runId: result.runId }) : t("forkCreatedFallback");
    }
    if (!lifecycleAction(run.lifecycle, action)) throw new Error(t("actionUnavailable", { action: actionLabel(action) }));
    await client.console[action].mutate({ runId, expectedManifestRef: run.committedManifestRef ?? "", idempotencyKey: key() });
    await Promise.all([refreshRun(), refreshCommitted()]);
    return t("requestAccepted", { action: actionLabel(action) });
  }, [actionLabel, client, feedConfig, feedOverride, feedVersionRef, marketMakerPresetVersionRef, marketMakerChoice, marketMakerConfig, marketMakerMatchingPolicy, marketMakerMaxRequotes, marketMakerRequotePolicy, marketMakerTiming, marketMakerVersionRef, refreshCommitted, refreshRun, run, runId, selectedManifestRef, t, turnPromptOverride, turnPromptVariables, turnPromptVersionRef]);
  const executeRef = useRef(executeAction); executeRef.current = executeAction;
  useEffect(() => {
    if (!actionState.matches("submitting") || !actionState.context.action) return;
    let current = true;
    void executeRef.current(actionState.context.action).then((result) => { if (current) sendAction({ type: "SUCCEED", result }); }).catch((error: unknown) => { if (current) sendAction({ type: "FAIL", error: error instanceof Error ? error.message : t("actionFailed") }); });
    return () => { current = false; };
  }, [actionState, sendAction, t]);

  function chooseFeedVersion(versionRef: string) { setFeedVersionRef(versionRef); const selected = feedAlgorithmVersions.find((item) => item.versionRef === versionRef); if (selected) setFeedConfig(pretty(selected.defaultConfig)); }
  function chooseMarketMakerVersion(versionRef: string) { setMarketMakerVersionRef(versionRef); const selected = marketMakerVersionList.find((item) => item.versionRef === versionRef); if (selected) setMarketMakerConfig(pretty(selected.defaultConfig)); }
  function chooseTurnPromptVersion(versionRef: string) { setTurnPromptVersionRef(versionRef); const selected = turnPromptVersionList.find((item) => item.versionRef === versionRef); setTurnPromptVariables(Object.fromEntries((selected?.variables ?? []).flatMap((definition) => definition.defaultValue === undefined ? [] : [[definition.name, definition.defaultValue]]))); }
  async function updateHookPolicy(next: Pick<HookPolicy, "strategyInjectionEnabled">) {
    if (!hookPolicy || hookPolicySaving) return;
    setHookPolicySaving(true);
    try {
      const response = record(await client.console.updateHookPolicy.mutate({
        runId,
        ...next,
        expectedRevision: hookPolicy.revision,
        idempotencyKey: key(),
      }));
      const policy = record(response.policy);
      if (typeof policy.revision !== "number") throw new Error(t("couldNotUpdateHookPolicy"));
      setHookPolicy(policy as unknown as HookPolicy);
      setStatus(t("hookPolicyUpdated"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("couldNotUpdateHookPolicy"));
    } finally {
      setHookPolicySaving(false);
    }
  }

  const auditRecord = record(audit);
  const runtimeEvidence = record(auditRecord.agentExecution);
  const resolvedPopulation = record(record(auditRecord.run).resolvedWorld).population;
  const mcpPolicies = Array.isArray(resolvedPopulation) ? resolvedPopulation.map((value) => {
    const member = record(value);
    return { agentId: member.agentId, versionRef: member.mcpPolicyVersionRef, artifactDigest: member.mcpPolicyArtifactDigest, permissions: member.mcpPolicy };
  }) : [];
  const skills = Array.isArray(resolvedPopulation) ? resolvedPopulation.map((value) => {
    const member = record(value);
    return { agentId: member.agentId, skills: Array.isArray(member.skills) ? member.skills : [] };
  }).filter((item) => item.skills.length > 0) : [];
  const artifactList = Array.isArray(runtimeEvidence.artifacts) ? runtimeEvidence.artifacts : [];
  const driftEvents = Array.isArray(runtimeEvidence.driftEvents) ? runtimeEvidence.driftEvents : [];
  const history = committed.length ? committed : (run?.committedManifestRef ? [{ ref: run.committedManifestRef, roundId: run.committedRound, state: "committed" }] : []);
  const selectedManifest = committed.find((item) => item.ref === selectedManifestRef);
  const dialogOpen = !actionState.matches("idle");

  return <>
    <Paper component="section" elevation={0} sx={{ border: 1, borderColor: "divider", p: { xs: 2, md: 3 } }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
        <Box><Typography component="h2" variant="h5">{run?.runId ?? runId}</Typography><Typography color="text.secondary" variant="body2">{view === "results" ? t("committedOnly") : `${({ overview: t("overview"), evidence: t("evidence"), usage: t("usage"), transcript: t("transcript"), results: t("results"), fork: t("fork") } as Record<WorkspaceView, string>)[view]} ${t("workspaceSuffix")}`}</Typography></Box>
        {view === "overview" && run && <Stack direction="row" spacing={1}>
          {lifecycleAction(run.lifecycle, "resume") && <Button onClick={() => sendAction({ type: "REQUEST", action: "resume" })} variant="contained">{t("resume")}</Button>}
          {(lifecycleAction(run.lifecycle, "retry") || run.lifecycle === "failed" && run.failure?.category.startsWith("round_advance_")) && <Button color="warning" onClick={() => sendAction({ type: "REQUEST", action: "retry" })} variant="contained">{t("retry")}</Button>}
          {lifecycleAction(run.lifecycle, "cancel") && <Button color="error" onClick={() => sendAction({ type: "REQUEST", action: "cancel" })} variant="outlined">{t("cancel")}</Button>}
        </Stack>}
      </Stack>
      <Alert severity={status.toLowerCase().includes("could not") ? "error" : "info"} sx={{ mt: 2 }}>{status}</Alert>
      <Divider sx={{ my: 3 }} />
      {view === "overview" && <Overview run={run} progress={progress} hookPolicy={hookPolicy} hookPolicySaving={hookPolicySaving} onHookPolicy={updateHookPolicy} />}
      {view === "evidence" && <Evidence run={run} evidence={runtimeEvidence} registrations={auditRecord.registrations} artifacts={artifactList} driftEvents={driftEvents} history={history} mcpPolicies={mcpPolicies} skills={skills} />}
      {view === "usage" && <TokenUsage runId={runId} turns={tokenUsage} />}
      {view === "transcript" && <TranscriptHistory loading={transcriptLoading} onMore={loadMoreTranscripts} value={transcripts} />}
      {view === "results" && <Results manifests={committed} selectedManifestRef={selectedManifestRef} onSelectManifest={setSelectedManifestRef} facts={facts} tab={resultTab} onTab={setResultTab} />}
      {view === "fork" && <Fork manifests={committed} selectedManifest={selectedManifest} selectedManifestRef={selectedManifestRef} onSelectManifest={setSelectedManifestRef} feedOverride={feedOverride} setFeedOverride={setFeedOverride} feedVersions={feedAlgorithmVersions} feedVersionRef={feedVersionRef} onFeedVersion={chooseFeedVersion} feedConfig={feedConfig} setFeedConfig={setFeedConfig} marketMakerChoice={marketMakerChoice} setMarketMakerChoice={setMarketMakerChoice} marketMakerVersions={marketMakerVersionList} marketMakerVersionRef={marketMakerVersionRef} onMarketMakerVersion={chooseMarketMakerVersion} marketMakerPresetVersionRef={marketMakerPresetVersionRef} setMarketMakerPresetVersionRef={setMarketMakerPresetVersionRef} marketMakerTiming={marketMakerTiming} setMarketMakerTiming={setMarketMakerTiming} marketMakerMatchingPolicy={marketMakerMatchingPolicy} setMarketMakerMatchingPolicy={setMarketMakerMatchingPolicy} marketMakerRequotePolicy={marketMakerRequotePolicy} setMarketMakerRequotePolicy={setMarketMakerRequotePolicy} marketMakerMaxRequotes={marketMakerMaxRequotes} setMarketMakerMaxRequotes={setMarketMakerMaxRequotes} marketMakerConfig={marketMakerConfig} setMarketMakerConfig={setMarketMakerConfig} turnPromptOverride={turnPromptOverride} setTurnPromptOverride={setTurnPromptOverride} turnPromptVersions={turnPromptVersionList} turnPromptVersionRef={turnPromptVersionRef} onTurnPromptVersion={chooseTurnPromptVersion} turnPromptVariables={turnPromptVariables} setTurnPromptVariables={setTurnPromptVariables} onFork={() => sendAction({ type: "REQUEST", action: "fork" })} />}
    </Paper>
    <RunActionDialog action={actionState.context.action} error={actionState.context.error} open={dialogOpen} phase={actionState.value} result={actionState.context.result} onConfirm={() => sendAction({ type: "CONFIRM" })} onDismiss={() => sendAction({ type: "DISMISS" })} />
  </>;
}

function TranscriptHistory({ loading, onMore, value }: { loading: boolean; onMore(): Promise<void>; value: Record<string, unknown> }) {
  const t = useTranslations("RunWorkspace");
  const items = Array.isArray(value.items) ? value.items.map(record) : [];
  if (value.availability === "legacy_unavailable") return <Alert severity="warning">{t("legacyTranscriptUnavailable")}</Alert>;
  if (!items.length) return <Typography color="text.secondary">{t("noTranscript")}</Typography>;
  return <Stack spacing={2}>
    <Box><Typography component="h3" variant="h6">{t("transcriptTitle")}</Typography><Typography color="text.secondary" variant="body2">{t("transcriptDescription")}</Typography></Box>
    {items.map((turn) => {
      const turnItems = Array.isArray(turn.items) ? turn.items.map(record) : [];
      const events = Array.isArray(turn.events) ? turn.events.map(record) : [];
      const summary = `${t("round")} ${String(turn.roundId)} · ${String(turn.agentId)} · ${String(turn.status)}`;
      return <Paper component="details" elevation={0} key={String(turn.transcriptRef)} sx={{ border: 1, borderColor: "divider", p: 2 }}>
        <Typography component="summary" sx={{ cursor: "pointer", fontWeight: 700 }}>{summary}</Typography>
        <Stack spacing={2} sx={{ mt: 2 }}>
          <JsonPanel label={t("sessionContext")} value={turn.session} />
          <JsonPanel label={t("turnPromptText")} value={turn.prompt} />
          {turnItems.map((item) => <JsonPanel key={`${String(turn.turnId)}:${String(item.sequence)}`} label={`${String(item.sequence)} · ${String(item.type)}`} value={item} />)}
          <JsonPanel label={t("protocolEvents")} value={events} empty={t("noData")} />
          <JsonPanel label={t("turnError")} value={turn.error} empty={t("noData")} />
        </Stack>
      </Paper>;
    })}
    {typeof value.nextCursor === "string" ? <Button disabled={loading} onClick={() => void onMore()} variant="outlined">{loading ? t("loadingMoreTranscript") : t("loadMoreTranscript")}</Button> : null}
  </Stack>;
}

function Overview({ run, progress, hookPolicy, hookPolicySaving, onHookPolicy }: { run: Run | undefined; progress: Progress | undefined; hookPolicy: HookPolicy | undefined; hookPolicySaving: boolean; onHookPolicy(next: Pick<HookPolicy, "strategyInjectionEnabled">): Promise<void> }) {
  const t = useTranslations("RunWorkspace");
  if (!run) return <Typography color="text.secondary">{t("loadingRun")}</Typography>;
  const progressState = ({ queued: t("queued"), running: t("running"), retry_wait: t("retry"), committing: t("working"), committed: t("results"), cancelled: t("cancel") } as Record<string, string>)[progress?.state ?? ""] ?? progress?.state ?? "";
  const items: Array<[string, string]> = [[t("lifecycle"), run.lifecycle], [t("committedRound"), `${run.committedRound} / ${run.configuredRounds}`], [t("currentManifest"), run.committedManifestRef ?? t("notInitialized")], [t("conditionDigest"), run.conditionDigest]];
  if (progress) items.push([t("roundProgress"), t("roundAttempt", { round: progress.roundId, attempt: progress.attempt, state: progressState })], [t("jobs"), t("jobSummary", progress)], [t("snapshotDigest"), progress.snapshotDigest]);
  if (progress?.recentError) items.push([t("recentError"), progress.recentError]);
  if (run.advanceRetry) items.push([
    t("recentError"),
    `${run.advanceRetry.recentError.category}: ${run.advanceRetry.recentError.message} (${run.advanceRetry.attempts}/${run.advanceRetry.maxAttempts}, ${run.advanceRetry.nextRetryAt})`,
  ]);
  if (run.failure) items.push([t("terminalFailure"), `${run.failure.category}: ${run.failure.message}`]);
  const policyMutable = !["completed", "cancelled", "failed"].includes(run.lifecycle);
  return <Stack spacing={3}>
    <InfoGrid items={items} />
    <Box>
      <Typography component="h3" variant="h6">{t("codexHookPolicy")}</Typography>
      <Typography color="text.secondary" variant="body2">{t("codexHookPolicyDescription")}</Typography>
      {hookPolicy ? <Stack sx={{ mt: 1 }}>
        <FormControlLabel control={<Switch checked={hookPolicy.strategyInjectionEnabled} disabled={!policyMutable || hookPolicySaving} onChange={(_, checked) => void onHookPolicy({ strategyInjectionEnabled: checked })} />} label={t("strategyInjection")} />
        <Typography color="text.secondary" variant="caption">{t("hookPolicyRevision", { revision: hookPolicy.revision })}</Typography>
      </Stack> : <Typography color="text.secondary" sx={{ mt: 1 }}>{t("loadingHookPolicy")}</Typography>}
    </Box>
  </Stack>;
}

function Evidence({ run, evidence, registrations, artifacts, driftEvents, history, mcpPolicies, skills }: { run: Run | undefined; evidence: Record<string, unknown>; registrations: unknown; artifacts: unknown[]; driftEvents: unknown[]; history: Manifest[]; mcpPolicies: unknown[]; skills: unknown[] }) {
  const t = useTranslations("RunWorkspace");
  const model = record(evidence.modelConfiguration);
  const sandbox = record(evidence.sandbox);
  const turnPrompt = record(evidence.turnPrompt);
  const instructionPolicy = record(evidence.instructionPolicy);
  const instructionPolicyMigrations = Array.isArray(evidence.instructionPolicyMigrations) ? evidence.instructionPolicyMigrations : [];
  return <Stack spacing={3}>
    <Box><Typography component="h3" variant="h6">{t("researchCondition")}</Typography><Typography color="text.secondary" variant="body2">{t("auditDescription")}</Typography></Box>
    <InfoGrid items={[[t("runConditionDigest"), run?.conditionDigest ?? t("loadingRun")], [t("agentConditionDigest"), stringOr(evidence.conditionDigest, t)], [t("staticArtifactDigest"), stringOr(evidence.staticArtifactDigest, t)], [t("agentModel"), stringOr(model.model, t)], [t("codexConfigDigest"), stringOr(model.configDigest, t)], [t("instructionPolicy"), stringOr(instructionPolicy.version, t)], [t("baseInstructionsDigest"), stringOr(instructionPolicy.baseInstructionsDigest, t)], [t("environmentContextDigest"), stringOr(instructionPolicy.environmentContextDigest, t)], [t("hostCurrentDate"), instructionPolicy.hostCurrentDateExposed === false ? t("notExposed") : t("unknown")], [t("turnPrompt"), stringOr(turnPrompt.versionRef, t)], [t("turnPromptDigest"), stringOr(turnPrompt.artifactDigest, t)]]} />
    <JsonPanel label={t("turnPromptVariables")} value={turnPrompt.variables} />
    <JsonPanel label={t("mcpPolicies")} value={mcpPolicies} empty={t("noMcpPolicies")} />
    <JsonPanel label={t("skills")} value={skills} empty={t("noSkills")} />
    <JsonPanel label={t("staticAgentArtifacts")} value={artifacts} empty={t("noArtifacts")} />
    <JsonPanel label={t("workspaceDrift")} value={driftEvents} empty={t("noDrift")} />
    <JsonPanel label={t("instructionPolicyMigrations")} value={instructionPolicyMigrations} empty={t("noInstructionPolicyMigrations")} />
    <JsonPanel label={t("sandboxLifecycle")} value={sandbox} empty={t("noSandbox")} />
    <JsonPanel label={t("agentRegistrations")} value={registrations} />
    <Box><Typography component="h3" variant="h6">{t("manifestHistory")}</Typography>{history.length ? <Stack spacing={1} sx={{ mt: 1.5 }}>{history.map((manifest) => <Paper key={manifest.ref} sx={{ border: 1, borderColor: "divider", p: 1.5 }} variant="outlined"><Typography sx={{ fontFamily: "monospace", fontSize: ".8rem" }}>{manifest.ref}</Typography><Typography color="text.secondary" variant="body2">{t("historyItem", { round: manifest.roundId, state: manifest.state })}</Typography></Paper>)}</Stack> : <Typography color="text.secondary" sx={{ mt: 1 }}>{t("noManifest")}</Typography>}</Box>
  </Stack>;
}

function TokenUsage({ runId, turns }: { runId: string; turns: unknown[] }) {
  const t = useTranslations("RunWorkspace");
  const rows = turns.flatMap((value) => {
    const turn = record(value);
    const responses = Array.isArray(turn.responses) ? turn.responses : [];
    return responses.map((responseValue) => {
      const response = record(responseValue);
      const usage = record(response.usage);
      const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.map((call) => {
        const item = record(call);
        const namespace = typeof item.namespace === "string" ? `${item.namespace}.` : "";
        return `${namespace}${String(item.name ?? "")}`;
      }).filter(Boolean) : [];
      return {
        roundId: Number(turn.roundId),
        agentId: String(turn.agentId ?? ""),
        sequence: Number(response.sequence),
        classification: String(response.classification ?? ""),
        actions: toolCalls.join(", ") || "—",
        totalTokens: tokenNumber(usage.totalTokens),
        inputTokens: tokenNumber(usage.inputTokens),
        outputTokens: tokenNumber(usage.outputTokens),
        reasoningTokens: tokenNumber(usage.reasoningOutputTokens),
        completeness: String(turn.completeness ?? ""),
      };
    });
  });
  const download = () => {
    const blob = new Blob([`${JSON.stringify(turns, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${runId}-token-usage.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
      <Box><Typography component="h3" variant="h6">{t("tokenUsageTitle")}</Typography><Typography color="text.secondary" variant="body2">{t("tokenUsageDescription")}</Typography></Box>
      <Button disabled={!turns.length} onClick={download} variant="outlined">{t("downloadUsage")}</Button>
    </Stack>
    {!rows.length ? <Alert severity="info">{t("noUsage")}</Alert> : <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead><TableRow>
          {[t("round"), t("agent"), t("response"), t("classification"), t("action"), t("totalTokens"), t("inputTokens"), t("outputTokens"), t("reasoningTokens"), t("completeness")].map((label) => <TableCell key={label}>{label}</TableCell>)}
        </TableRow></TableHead>
        <TableBody>{rows.map((row) => <TableRow key={`${row.roundId}:${row.agentId}:${row.sequence}`}>
          <TableCell>{row.roundId}</TableCell><TableCell>{row.agentId}</TableCell><TableCell>{row.sequence}</TableCell>
          <TableCell>{row.classification}</TableCell><TableCell>{row.actions}</TableCell>
          <TableCell>{row.totalTokens}</TableCell><TableCell>{row.inputTokens}</TableCell><TableCell>{row.outputTokens}</TableCell><TableCell>{row.reasoningTokens}</TableCell>
          <TableCell>{row.completeness}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </TableContainer>}
  </Stack>;
}

function tokenNumber(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : "—";
}

function Results({ manifests, selectedManifestRef, onSelectManifest, facts, tab, onTab }: { manifests: Manifest[]; selectedManifestRef: string; onSelectManifest(value: string): void; facts: Record<string, unknown> | undefined; tab: ResultTab; onTab(value: ResultTab): void }) {
  const t = useTranslations("RunWorkspace");
  if (!manifests.length) return <Alert severity="info">{t("resultsUnavailable")}</Alert>;
  const contextFacts = record(facts?.contexts);
  const entries: Array<[ResultTab, string, unknown]> = [["manifest", t("manifest"), facts?.manifest], ["agentExecution", t("agentExecution"), facts?.agentExecution], ...Object.entries(contextFacts).sort(([left], [right]) => left.localeCompare(right)).map(([contextId, value]) => [contextId, contextId, value] as [ResultTab, string, unknown])];
  const current = entries.find(([name]) => name === tab);
  return <Stack spacing={2.5}>
    <FormControl size="small" sx={{ maxWidth: 680 }}><InputLabel id="committed-manifest-label">{t("committedManifest")}</InputLabel><Select label={t("committedManifest")} labelId="committed-manifest-label" onChange={(event) => onSelectManifest(event.target.value)} value={selectedManifestRef}>{manifests.map((manifest) => <MenuItem key={manifest.ref} value={manifest.ref}>{t("roundManifest", { round: manifest.roundId, manifest: manifest.ref })}</MenuItem>)}</Select></FormControl>
    <Alert severity="success">{t("committedSource", { manifest: selectedManifestRef })}</Alert>
    <Tabs aria-label={t("results")} onChange={(_, next: ResultTab) => onTab(next)} value={tab} variant="scrollable">{entries.map(([name, label]) => <Tab key={name} label={label} value={name} />)}</Tabs>
    {current && current[0] !== "manifest" && current[0] !== "agentExecution"
      ? <ContextPluginSurface contextId={current[0]} surface="facts" runId={String(record(facts?.manifest).runId ?? "")} revisionRef={String(record(current[2]).ref ?? "")} />
      : <JsonPanel label={current?.[1] ?? t("results")} value={facts ? current?.[2] : undefined} empty={t("loadingFacts")} />}
  </Stack>;
}

function Fork({ manifests, selectedManifest, selectedManifestRef, onSelectManifest, feedOverride, setFeedOverride, feedVersions: publishedFeedVersions, feedVersionRef, onFeedVersion, feedConfig, setFeedConfig, marketMakerChoice, setMarketMakerChoice, marketMakerVersions: publishedMarketMakerVersions, marketMakerVersionRef, onMarketMakerVersion, marketMakerPresetVersionRef, setMarketMakerPresetVersionRef, marketMakerTiming, setMarketMakerTiming, marketMakerMatchingPolicy, setMarketMakerMatchingPolicy, marketMakerRequotePolicy, setMarketMakerRequotePolicy, marketMakerMaxRequotes, setMarketMakerMaxRequotes, marketMakerConfig, setMarketMakerConfig, turnPromptOverride, setTurnPromptOverride, turnPromptVersions: publishedTurnPromptVersions, turnPromptVersionRef, onTurnPromptVersion, turnPromptVariables, setTurnPromptVariables, onFork }: { manifests: Manifest[]; selectedManifest: Manifest | undefined; selectedManifestRef: string; onSelectManifest(value: string): void; feedOverride: boolean; setFeedOverride(value: boolean): void; feedVersions: FeedAlgorithmVersion[]; feedVersionRef: string; onFeedVersion(value: string): void; feedConfig: string; setFeedConfig(value: string): void; marketMakerChoice: MarketMakerForkChoice; setMarketMakerChoice(value: MarketMakerForkChoice): void; marketMakerVersions: MarketMakerVersion[]; marketMakerVersionRef: string; onMarketMakerVersion(value: string): void; marketMakerPresetVersionRef: string; setMarketMakerPresetVersionRef(value: string): void; marketMakerTiming: "opening" | "settlement"; setMarketMakerTiming(value: "opening" | "settlement"): void; marketMakerMatchingPolicy: "batch" | "incremental"; setMarketMakerMatchingPolicy(value: "batch" | "incremental"): void; marketMakerRequotePolicy: "none" | "after_each_trade"; setMarketMakerRequotePolicy(value: "none" | "after_each_trade"): void; marketMakerMaxRequotes: number; setMarketMakerMaxRequotes(value: number): void; marketMakerConfig: string; setMarketMakerConfig(value: string): void; turnPromptOverride: boolean; setTurnPromptOverride(value: boolean): void; turnPromptVersions: TurnPromptVersion[]; turnPromptVersionRef: string; onTurnPromptVersion(value: string): void; turnPromptVariables: Record<string, TurnPromptVariableValue>; setTurnPromptVariables(value: Record<string, TurnPromptVariableValue>): void; onFork(): void }) {
  const t = useTranslations("RunWorkspace");
  if (!manifests.length) return <Alert severity="info">{t("forkUnavailable")}</Alert>;
  return <Stack spacing={3}>
    <FormControl size="small" sx={{ maxWidth: 680 }}><InputLabel id="fork-manifest-label">{t("sourceManifest")}</InputLabel><Select label={t("sourceManifest")} labelId="fork-manifest-label" onChange={(event) => onSelectManifest(event.target.value)} value={selectedManifestRef}>{manifests.map((manifest) => <MenuItem key={manifest.ref} value={manifest.ref}>{t("roundManifest", { round: manifest.roundId, manifest: manifest.ref })}</MenuItem>)}</Select></FormControl>
    <Alert severity="info">{t("forkInheritance", { manifest: selectedManifest?.ref ?? t("sourceManifest") })}</Alert>
    <Paper sx={{ border: 1, borderColor: "divider", p: 2.5 }} variant="outlined"><FormControlLabel control={<Switch checked={feedOverride} onChange={(event) => setFeedOverride(event.target.checked)} />} label={t("overrideFeed")} />
      {feedOverride && <Grid container spacing={2} sx={{ mt: .25 }}><Grid size={{ xs: 12, md: 5 }}><FormControl fullWidth size="small"><InputLabel id="feed-version-label">{t("publishedVersion")}</InputLabel><Select label={t("publishedVersion")} labelId="feed-version-label" onChange={(event) => onFeedVersion(event.target.value)} value={feedVersionRef}><MenuItem value="">{t("selectVersion")}</MenuItem>{publishedFeedVersions.map((version) => <MenuItem key={version.versionRef} value={version.versionRef}>{version.name} · {version.versionRef}</MenuItem>)}</Select></FormControl></Grid><Grid size={{ xs: 12, md: 7 }}><TextField fullWidth label={t("forkConfig")} minRows={5} multiline onChange={(event) => setFeedConfig(event.target.value)} value={feedConfig} /></Grid></Grid>}
    </Paper>
    <Paper sx={{ border: 1, borderColor: "divider", p: 2.5 }} variant="outlined"><FormControl fullWidth size="small"><InputLabel id="market-maker-choice-label">{t("marketMakerFork")}</InputLabel><Select label={t("marketMakerFork")} labelId="market-maker-choice-label" onChange={(event) => setMarketMakerChoice(event.target.value as MarketMakerForkChoice)} value={marketMakerChoice}><MenuItem value="inherit">{t("inheritSource")}</MenuItem><MenuItem value="select">{t("usePublished")}</MenuItem><MenuItem value="disable">{t("disableMarketMaker")}</MenuItem></Select></FormControl>
      {marketMakerChoice === "select" && <Grid container spacing={2} sx={{ mt: 2 }}><Grid size={{ xs: 12, md: 4 }}><FormControl fullWidth size="small"><InputLabel id="market-maker-version-label">{t("publishedVersion")}</InputLabel><Select label={t("publishedVersion")} labelId="market-maker-version-label" onChange={(event) => onMarketMakerVersion(event.target.value)} value={marketMakerVersionRef}><MenuItem value="">{t("selectVersion")}</MenuItem>{publishedMarketMakerVersions.map((version) => <MenuItem key={version.versionRef} value={version.versionRef}>{version.name} · {version.versionRef}</MenuItem>)}</Select></FormControl></Grid><Grid size={{ xs: 12, md: 4 }}><TextField fullWidth label={t("makerPreset")} onChange={(event) => setMarketMakerPresetVersionRef(event.target.value)} value={marketMakerPresetVersionRef} /></Grid><Grid size={{ xs: 12, md: 4 }}><FormControl fullWidth size="small"><InputLabel id="market-maker-timing-label">{t("timing")}</InputLabel><Select label={t("timing")} labelId="market-maker-timing-label" onChange={(event) => setMarketMakerTiming(event.target.value as "opening" | "settlement")} value={marketMakerTiming}><MenuItem value="opening">{t("opening")}</MenuItem><MenuItem value="settlement">{t("settlement")}</MenuItem></Select></FormControl></Grid><Grid size={{ xs: 12, md: 4 }}><FormControl fullWidth size="small"><InputLabel id="market-maker-matching-label">{t("matchingPolicy")}</InputLabel><Select label={t("matchingPolicy")} labelId="market-maker-matching-label" value={marketMakerMatchingPolicy} onChange={(event) => { const value = event.target.value as "batch" | "incremental"; setMarketMakerMatchingPolicy(value); if (value === "batch") setMarketMakerRequotePolicy("none"); }}><MenuItem value="batch">{t("batchMatching")}</MenuItem><MenuItem value="incremental">{t("incrementalMatching")}</MenuItem></Select></FormControl></Grid><Grid size={{ xs: 12, md: 4 }}><FormControl fullWidth size="small"><InputLabel id="market-maker-requote-label">{t("requotePolicy")}</InputLabel><Select label={t("requotePolicy")} labelId="market-maker-requote-label" value={marketMakerRequotePolicy} onChange={(event) => { const value = event.target.value as "none" | "after_each_trade"; setMarketMakerRequotePolicy(value); if (value === "after_each_trade") setMarketMakerMatchingPolicy("incremental"); }}><MenuItem value="none">{t("noRequote")}</MenuItem><MenuItem value="after_each_trade">{t("afterEachTrade")}</MenuItem></Select></FormControl></Grid>{marketMakerRequotePolicy === "after_each_trade" && <Grid size={{ xs: 12, md: 4 }}><TextField fullWidth label={t("maxRequotesPerIntent")} type="number" slotProps={{ htmlInput: { min: 1, max: 100000 } }} value={marketMakerMaxRequotes} onChange={(event) => setMarketMakerMaxRequotes(Number(event.target.value))} /></Grid>}<Grid size={12}><TextField fullWidth label={t("forkConfig")} minRows={5} multiline onChange={(event) => setMarketMakerConfig(event.target.value)} value={marketMakerConfig} /></Grid></Grid>}
    </Paper>
    <Paper sx={{ border: 1, borderColor: "divider", p: 2.5 }} variant="outlined"><FormControlLabel control={<Switch checked={turnPromptOverride} onChange={(event) => setTurnPromptOverride(event.target.checked)} />} label={t("overrideTurnPrompt")} />{turnPromptOverride && <Stack spacing={2} sx={{ mt: 2 }}><FormControl fullWidth size="small"><InputLabel id="turn-prompt-version-label">{t("turnPrompt")}</InputLabel><Select label={t("turnPrompt")} labelId="turn-prompt-version-label" value={turnPromptVersionRef} onChange={(event) => onTurnPromptVersion(event.target.value)}><MenuItem value="">{t("selectVersion")}</MenuItem>{publishedTurnPromptVersions.map((version) => <MenuItem key={version.versionRef} value={version.versionRef}>{version.name} · {version.versionRef}</MenuItem>)}</Select></FormControl>{publishedTurnPromptVersions.find((version) => version.versionRef === turnPromptVersionRef)?.variables.map((definition) => <ForkPromptValue key={definition.name} definition={definition} value={turnPromptVariables[definition.name]} onChange={(value) => setTurnPromptVariables({ ...turnPromptVariables, [definition.name]: value })} />)}</Stack>}</Paper>
    <Box><Button onClick={onFork} variant="contained">{t("createForkAction")}</Button></Box>
  </Stack>;
}

function RunActionDialog({ action, error, open, phase, result, onConfirm, onDismiss }: { action: RunAction | undefined; error: string | undefined; open: boolean; phase: unknown; result: string | undefined; onConfirm(): void; onDismiss(): void }) {
  const t = useTranslations("RunWorkspace");
  const actionLabel = ({ resume: t("resumeRun"), retry: t("retryRun"), cancel: t("cancelRun"), fork: t("createFork") } as Record<RunAction, string>)[action ?? "resume"];
  const actionDescription = ({ resume: t("resumeDescription"), retry: t("retryDescription"), cancel: t("cancelDescription"), fork: t("forkDescription") } as Record<RunAction, string>)[action ?? "resume"];
  const submitting = phase === "submitting";
  const completed = phase === "succeeded" || phase === "failed";
  return <Dialog aria-labelledby="run-action-title" onClose={submitting ? undefined : onDismiss} open={open}>
    <DialogTitle id="run-action-title">{actionLabel}</DialogTitle>
    <DialogContent><DialogContentText>{submitting ? t("submitting") : completed ? (error ?? result) : actionDescription}</DialogContentText>{phase === "failed" && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}{phase === "succeeded" && <Alert severity="success" sx={{ mt: 2 }}>{result}</Alert>}</DialogContent>
    <DialogActions>{completed ? <Button onClick={onDismiss}>{t("done")}</Button> : <><Button disabled={submitting} onClick={onDismiss}>{t("back")}</Button><Button color={action === "cancel" ? "error" : "primary"} disabled={submitting} onClick={onConfirm} variant="contained">{submitting ? t("working") : t("confirm")}</Button></>}</DialogActions>
  </Dialog>;
}

function ForkPromptValue({ definition, value, onChange }: { definition: TurnPromptVariableDefinition; value: TurnPromptVariableValue | undefined; onChange(value: TurnPromptVariableValue): void }) {
  if (definition.type === "boolean") return <TextField select label={definition.name} value={String(value ?? definition.defaultValue ?? false)} onChange={(event) => onChange(event.target.value === "true")}><MenuItem value="true">true</MenuItem><MenuItem value="false">false</MenuItem></TextField>;
  return <TextField label={definition.name} helperText={definition.description} multiline={definition.type === "string"} type={definition.type === "number" ? "number" : "text"} value={value ?? ""} onChange={(event) => onChange(definition.type === "number" ? Number(event.target.value) : event.target.value)} />;
}

function InfoGrid({ items }: { items: Array<[string, string]> }) { return <Grid container spacing={2}>{items.map(([label, value]) => <Grid key={label} size={{ xs: 12, sm: 6, lg: 4 }}><Paper sx={{ border: 1, borderColor: "divider", height: "100%", p: 2 }} variant="outlined"><Typography color="text.secondary" variant="caption">{label}</Typography><Typography sx={{ fontFamily: label.includes("digest") || label.includes("manifest") ? "monospace" : undefined, overflowWrap: "anywhere", mt: .5 }} variant="body2">{value}</Typography></Paper></Grid>)}</Grid>; }
function JsonPanel({ label, value, empty }: { label: string; value: unknown; empty?: string }) { const t = useTranslations("RunWorkspace"); const isEmpty = value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (!Array.isArray(value) && typeof value === "object" && Object.keys(record(value)).length === 0); return <Box><Typography component="h3" variant="h6">{label}</Typography>{isEmpty ? <Typography color="text.secondary" sx={{ mt: 1 }}>{empty ?? t("noData")}</Typography> : <Paper component="pre" sx={{ bgcolor: "grey.900", color: "grey.100", fontFamily: "monospace", fontSize: ".78rem", maxHeight: 480, mt: 1.5, overflow: "auto", p: 2, whiteSpace: "pre-wrap" }}>{pretty(value)}</Paper>}</Box>; }
function stringOr(value: unknown, t: ReturnType<typeof useTranslations>) { return typeof value === "string" && value ? value : t("unavailable"); }

export type { WorkspaceView };
