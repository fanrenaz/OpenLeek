"use client";

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

type Procedure = { query(input: unknown): Promise<unknown> };
type Client = { console: { runs: Procedure } };
type Lifecycle = "queued" | "initializing" | "running" | "retry_wait" | "cancel_requested" | "completed" | "cancelled" | "failed";
type Run = {
  runId: string;
  lifecycle: Lifecycle;
  committedRound: number;
  configuredRounds: number;
  conditionDigest: string;
  committedManifestRef?: string;
  failure?: { category: string; message: string };
};
type RunPage = { runs: Run[]; nextCursor?: string };

function api(): Client {
  return createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;
}

function parsePage(value: unknown): RunPage {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    runs: Array.isArray(record.runs) ? record.runs as Run[] : [],
    ...(typeof record.nextCursor === "string" ? { nextCursor: record.nextCursor } : {}),
  };
}

function lifecycleColor(lifecycle: Lifecycle): "default" | "success" | "warning" | "error" | "info" {
  if (lifecycle === "completed") return "success";
  if (lifecycle === "failed" || lifecycle === "retry_wait") return "error";
  if (lifecycle === "queued" || lifecycle === "initializing" || lifecycle === "cancel_requested") return "warning";
  if (lifecycle === "running") return "info";
  return "default";
}

export function RunIndex() {
  const t = useTranslations("Runs");
  const common = useTranslations("Common");
  const client = useMemo(api, []);
  const [lifecycle, setLifecycle] = useState<"" | Lifecycle>("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [status, setStatus] = useState(t("loading"));
  const lifecycleOptions: Array<{ value: "" | Lifecycle; label: string }> = [
    { value: "", label: t("allLifecycles") }, { value: "queued", label: t("queued") }, { value: "initializing", label: t("initializing") }, { value: "running", label: t("running") }, { value: "retry_wait", label: t("retryNeeded") }, { value: "cancel_requested", label: t("cancelRequested") }, { value: "completed", label: t("completed") }, { value: "failed", label: t("failed") }, { value: "cancelled", label: t("cancelled") },
  ];
  const lifecycleLabel = (lifecycle: Lifecycle) => ({ queued: t("queued"), initializing: t("initializing"), running: t("running"), retry_wait: t("retryNeeded"), cancel_requested: t("cancelRequested"), completed: t("completed"), cancelled: t("cancelled"), failed: t("failed") } as Record<Lifecycle, string>)[lifecycle];

  const load = useCallback(async (cursor?: string, append = false) => {
    try {
      const page = parsePage(await client.console.runs.query({ limit: 50, ...(lifecycle ? { lifecycle } : {}), ...(cursor ? { cursor } : {}) }));
      setRuns((current) => append ? [...current, ...page.runs] : page.runs);
      setNextCursor(page.nextCursor);
      setStatus(page.runs.length || append ? t("indexCurrent") : t("noLifecycleMatches"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("couldNotLoad"));
    }
  }, [client, lifecycle, t]);

  useEffect(() => { void load(); }, [load]);

  return <Box component="main" sx={{ maxWidth: 1520, mx: "auto", px: { xs: 2, md: 4 }, py: { xs: 3, md: 5 } }}>
    <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ alignItems: { md: "flex-end" }, justifyContent: "space-between" }}>
      <Box>
        <Typography color="primary.main" variant="overline">{t("researchRuns")}</Typography>
        <Typography component="h1" variant="h1">{t("title")}</Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 680, mt: 1 }}>{t("description")}</Typography>
      </Box>
      <Button component={Link} href="/runs/new" startIcon={<AddRoundedIcon />} variant="contained">{t("createRun")}</Button>
    </Stack>

    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", mt: 4, overflow: "hidden" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, borderBottom: 1, borderColor: "divider", justifyContent: "space-between", p: 2 }}>
        <FormControl size="small" sx={{ minWidth: 210 }}>
          <InputLabel id="run-lifecycle-label">{t("lifecycle")}</InputLabel>
          <Select label={t("lifecycle")} labelId="run-lifecycle-label" onChange={(event) => setLifecycle(event.target.value as "" | Lifecycle)} value={lifecycle}>
            {lifecycleOptions.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
          </Select>
        </FormControl>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
          <Typography aria-live="polite" color="text.secondary" variant="body2">{status}</Typography>
          <Button onClick={() => void load()} size="small" startIcon={<RefreshRoundedIcon />} variant="outlined">{common("refresh")}</Button>
        </Stack>
      </Stack>

      {runs.length ? <TableContainer>
        <Table aria-label={t("title")} sx={{ minWidth: 860 }}>
          <TableHead><TableRow>
            <TableCell>{t("run")}</TableCell><TableCell>{t("lifecycle")}</TableCell><TableCell>{t("committedRound")}</TableCell><TableCell>{t("conditionDigest")}</TableCell><TableCell>{t("latestCommittedState")}</TableCell>
          </TableRow></TableHead>
          <TableBody>{runs.map((run) => <TableRow component={Link} hover href={`/runs/${encodeURIComponent(run.runId)}`} key={run.runId} sx={{ "&": { color: "inherit", textDecoration: "none" }, cursor: "pointer" }}>
            <TableCell><Typography sx={{ fontWeight: 700 }}>{run.runId}</Typography></TableCell>
            <TableCell><Chip color={lifecycleColor(run.lifecycle)} label={lifecycleLabel(run.lifecycle)} size="small" variant="outlined" /></TableCell>
            <TableCell>{run.committedRound} / {run.configuredRounds}</TableCell>
            <TableCell><Typography component="code" sx={{ fontFamily: "monospace", fontSize: ".8rem" }} title={run.conditionDigest}>{run.conditionDigest.slice(0, 16)}</Typography></TableCell>
            <TableCell><Typography color={run.failure ? "error.main" : "text.secondary"} variant="body2">{run.failure ? `${run.failure.category}: ${run.failure.message}` : run.committedManifestRef ? t("manifestAvailable") : t("notInitialized")}</Typography></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer> : <Box sx={{ p: 5, textAlign: "center" }}><Typography component="h2" variant="h6">{t("emptyTitle")}</Typography><Typography color="text.secondary" sx={{ mt: 1 }}>{t("emptyDescription")}</Typography><Button component={Link} href="/runs/new" sx={{ mt: 2 }} variant="outlined">{t("createRun")}</Button></Box>}
    </Paper>
    {nextCursor && <Box sx={{ mt: 2, textAlign: "center" }}><Button onClick={() => void load(nextCursor, true)} variant="outlined">{t("loadMore")}</Button></Box>}
    <Alert severity="info" sx={{ mt: 3 }}>{t("controlPlaneNote")}</Alert>
  </Box>;
}
