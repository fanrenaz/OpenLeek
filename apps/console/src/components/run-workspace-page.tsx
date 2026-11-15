"use client";

import { Box, Breadcrumbs, Button, Link as MuiLink, Stack, Tab, Tabs, Typography } from "@mui/material";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { RunWorkspace, type WorkspaceView } from "./run-workspace";

export function RunWorkspacePage({ runId, view }: { runId: string; view: WorkspaceView }) {
  const t = useTranslations("RunWorkspace");
  const viewLabels: Record<WorkspaceView, string> = { overview: t("overview"), evidence: t("evidence"), usage: t("usage"), transcript: t("transcript"), results: t("results"), fork: t("fork") };
  const base = `/runs/${encodeURIComponent(runId)}`;
  return <Box component="main" sx={{ maxWidth: 1520, mx: "auto", px: { xs: 2, md: 4 }, py: { xs: 3, md: 5 } }}>
    <Breadcrumbs aria-label={t("breadcrumb")} sx={{ mb: 2 }}><MuiLink component={Link} href="/" underline="hover">{t("workspace")}</MuiLink><Typography color="text.primary">{runId}</Typography></Breadcrumbs>
    <Typography color="primary.main" variant="overline">{t("workspace")}</Typography>
    <Typography component="h1" variant="h1">{runId}</Typography>
    <Typography color="text.secondary" sx={{ maxWidth: 720, mt: 1 }}>{t("summary")}</Typography>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 3 }}>
      <Button component="a" href={`/contexts/financial/runs/${encodeURIComponent(runId)}`} variant="contained">{t("marketClient")}</Button>
      <Button component="a" href={`/contexts/social/runs/${encodeURIComponent(runId)}`} variant="outlined">{t("socialClient")}</Button>
    </Stack>
    <Tabs aria-label={t("workspaceViews")} sx={{ borderBottom: 1, borderColor: "divider", mt: 4 }} value={view} variant="scrollable">
      {(Object.entries(viewLabels) as Array<[WorkspaceView, string]>).map(([item, label]) => <Tab component={Link} href={item === "overview" ? base : `${base}/${item}`} key={item} label={label} value={item} />)}
    </Tabs>
    <Box sx={{ mt: 3 }}><RunWorkspace runId={runId} view={view} /></Box>
  </Box>;
}
