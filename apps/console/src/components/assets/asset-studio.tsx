"use client";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  assetDraftHref,
  assetNewHref,
  assetVersionHref,
  parseAssetPathname,
} from "./asset-routes";
import {
  PublishedVersionMetadata,
  RawDataDisclosure,
} from "./published-version-details";

export type AssetLibraryItem<TData = unknown> = {
  id: string;
  title: string;
  detail: string;
  timestamp?: string | undefined;
  data?: TData;
};

export type PublishedVersionData = {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
};

export type AssetLevel = "individual" | "global";

type AssetStudioProps<TVersionData extends PublishedVersionData> = {
  level?: AssetLevel;
  title: string;
  description: string;
  status: string;
  phase: string;
  drafts: AssetLibraryItem[];
  versions: AssetLibraryItem<TVersionData>[];
  selectedDraftId?: string;
  onRefresh(): void;
  onCreate(): void;
  createLabel: string;
  onSelectDraft(item: AssetLibraryItem): void;
  onCreateFromVersion(item: AssetLibraryItem<TVersionData>): void;
  renderVersionDetails(item: AssetLibraryItem<TVersionData>): ReactNode;
  editor: ReactNode;
  actions: ReactNode;
  publishOpen: boolean;
  onCancelPublish(): void;
  onConfirmPublish(): void;
  publishTitle: string;
  publishDescription: string;
};

export function AssetStudio<TVersionData extends PublishedVersionData>({
  level,
  title,
  description,
  status,
  phase,
  drafts,
  versions,
  selectedDraftId,
  onRefresh,
  onCreate,
  createLabel,
  onSelectDraft,
  onCreateFromVersion,
  renderVersionDetails,
  editor,
  actions,
  publishOpen,
  onCancelPublish,
  onConfirmPublish,
  publishTitle,
  publishDescription,
}: AssetStudioProps<TVersionData>) {
  const t = useTranslations("Assets");
  const common = useTranslations("Common");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const location = useMemo(() => parseAssetPathname(pathname), [pathname]);
  const fromVersion = searchParams.get("fromVersion") ?? undefined;
  const activeTab = searchParams.get("tab") === "drafts" ? "drafts" : "published";
  const routeKey = `${pathname}?fromVersion=${fromVersion ?? ""}`;
  const initializedRoute = useRef("");
  const publishBaseline = useRef<Set<string> | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [locallyDirty, setLocallyDirty] = useState(false);
  const resolvedLevel = level ?? (pathname.startsWith("/assets/individual/") ? "individual" : "global");
  const levelLabel = pathname.startsWith("/agent-factory")
    ? t("agentFactory")
    : pathname.startsWith("/world-factory")
      ? t("worldFactory")
      : t(resolvedLevel === "individual" ? "individualLevel" : "globalLevel");

  const selectedVersion = location.kind === "version"
    ? versions.find((item) => item.id === location.id)
    : undefined;
  const selectedDraft = location.kind === "draft"
    ? drafts.find((item) => item.id === location.id)
    : undefined;
  const sourceVersion = location.kind === "new" && fromVersion
    ? versions.find((item) => item.id === fromVersion)
    : undefined;
  const persistedDraftSignature = selectedDraftId
    ? drafts.find((item) => item.id === selectedDraftId)?.detail
    : undefined;
  const dirty = phase === "dirty" || locallyDirty;
  const loadingTarget = phase === "loading" && (
    location.kind === "draft" ||
    location.kind === "version" ||
    Boolean(fromVersion)
  );

  useEffect(() => {
    if (initializedRoute.current === routeKey || loadingTarget) return;
    if (location.kind === "new") {
      if (fromVersion) {
        if (!sourceVersion) return;
        onCreateFromVersion(sourceVersion);
      } else {
        onCreate();
      }
      initializedRoute.current = routeKey;
      return;
    }
    if (location.kind === "draft" && selectedDraft) {
      onSelectDraft(selectedDraft);
      initializedRoute.current = routeKey;
    }
  }, [fromVersion, loadingTarget, location.kind, onCreate, onCreateFromVersion, onSelectDraft, routeKey, selectedDraft, sourceVersion]);

  useEffect(() => setLocallyDirty(false), [persistedDraftSignature, routeKey]);

  useEffect(() => {
    if (location.kind === "new" && initializedRoute.current === routeKey && selectedDraftId) {
      router.replace(assetDraftHref(location.basePath, selectedDraftId));
    }
  }, [location, routeKey, router, selectedDraftId]);

  useEffect(() => {
    if (!publishBaseline.current) return;
    const published = versions.find((item) => !publishBaseline.current?.has(item.id)) ?? (
      phase === "ready" && selectedDraftId
        ? versions.find((item) => item.data && typeof item.data === "object" && Object.values(item.data as Record<string, unknown>).includes(selectedDraftId))
        : undefined
    );
    if (published) {
      publishBaseline.current = null;
      router.replace(assetVersionHref(location.basePath, published.id));
    } else if (phase === "failure") {
      publishBaseline.current = null;
    }
  }, [location.basePath, phase, router, versions]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const requestBack = () => {
    if (dirty) setDiscardOpen(true);
    else router.push(location.basePath);
  };

  if (location.kind === "library") {
    return <AssetLibraryPage
      activeTab={activeTab}
      basePath={location.basePath}
      createLabel={createLabel}
      description={description}
      drafts={drafts}
      onRefresh={onRefresh}
      phase={phase}
      status={status}
      title={title}
      versions={versions}
      levelLabel={levelLabel}
      onTabChange={(tab) => router.replace(`${location.basePath}?tab=${tab}`, { scroll: false })}
    />;
  }

  const missingTarget = !loadingTarget && (
    (location.kind === "draft" && !selectedDraft) ||
    (location.kind === "version" && !selectedVersion) ||
    (location.kind === "new" && Boolean(fromVersion) && !sourceVersion)
  );

  if (loadingTarget) {
    return <PageFrame description={description} eyebrow={common("loading")} levelLabel={levelLabel} title={title}>
      <Paper elevation={0} sx={{ border: 1, borderColor: "divider", p: { xs: 2, sm: 3 } }}>
        <Stack spacing={2}><Skeleton height={44} width="42%" /><Skeleton height={64} /><Skeleton height={180} /></Stack>
      </Paper>
    </PageFrame>;
  }

  if (missingTarget) {
    return <PageFrame description={description} eyebrow={t("notFoundEyebrow")} levelLabel={levelLabel} title={title}>
      <Alert severity="error" action={<Button onClick={() => router.push(location.basePath)}>{t("backToLibrary")}</Button>}>
        {t("assetNotFound")}
      </Alert>
    </PageFrame>;
  }

  if (location.kind === "version" && selectedVersion) {
    return <PageFrame
      description={description}
      eyebrow={t("publishedVersion")}
      levelLabel={levelLabel}
      title={selectedVersion.title}
      actions={<Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
        <Button onClick={() => router.push(location.basePath)} startIcon={<ArrowBackRoundedIcon />} variant="text">{t("backToLibrary")}</Button>
        <Button component={Link} href={assetNewHref(location.basePath, selectedVersion.id)} startIcon={<AddRoundedIcon />} variant="contained">{t("createFromVersion")}</Button>
      </Stack>}
    >
      <Paper component="article" elevation={0} sx={{ border: 1, borderColor: "divider", overflow: "hidden" }}>
        <Box sx={{ bgcolor: "grey.50", px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 2.5 } }}>
          <PublishedVersionMetadata item={selectedVersion} />
        </Box>
        <Divider />
        <Stack spacing={4.5} sx={{ px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 } }}>
          {renderVersionDetails(selectedVersion)}
          <RawDataDisclosure value={selectedVersion.data ?? selectedVersion} />
        </Stack>
      </Paper>
    </PageFrame>;
  }

  return <PageFrame
    description={description}
    eyebrow={location.kind === "new" ? t("newDraft") : t("editDraft")}
    levelLabel={levelLabel}
    title={location.kind === "new" ? createLabel : selectedDraft?.title ?? title}
    actions={<Button onClick={requestBack} startIcon={<ArrowBackRoundedIcon />} variant="text">{t("backToLibrary")}</Button>}
  >
    <Alert aria-live="polite" severity={phase === "failure" ? "error" : "info"} sx={{ mb: 2.5 }}>{status}</Alert>
    <Paper elevation={0} onChangeCapture={() => setLocallyDirty(true)} onInputCapture={() => setLocallyDirty(true)} sx={{ border: 1, borderColor: "divider", minWidth: 0, p: { xs: 2, sm: 3 } }}>
      {editor}
      <Box sx={{ borderTop: 1, borderColor: "divider", mt: 3, pt: 2.5 }}>{actions}</Box>
    </Paper>
    <Dialog aria-describedby="asset-publish-description" onClose={onCancelPublish} open={publishOpen}>
      <DialogTitle>{publishTitle}</DialogTitle>
      <DialogContent><DialogContentText id="asset-publish-description">{publishDescription}</DialogContentText></DialogContent>
      <DialogActions>
        <Button onClick={onCancelPublish}>{common("cancel")}</Button>
        <Button color="primary" onClick={() => {
          publishBaseline.current = new Set(versions.map((item) => item.id));
          onConfirmPublish();
        }} variant="contained">{t("publishImmutable")}</Button>
      </DialogActions>
    </Dialog>
    <Dialog onClose={() => setDiscardOpen(false)} open={discardOpen}>
      <DialogTitle>{t("discardTitle")}</DialogTitle>
      <DialogContent><DialogContentText>{t("discardDescription")}</DialogContentText></DialogContent>
      <DialogActions><Button onClick={() => setDiscardOpen(false)}>{common("cancel")}</Button><Button color="error" onClick={() => router.push(location.basePath)}>{common("discard")}</Button></DialogActions>
    </Dialog>
  </PageFrame>;
}

function AssetLibraryPage({ activeTab, basePath, createLabel, description, drafts, levelLabel, onRefresh, onTabChange, phase, status, title, versions }: {
  activeTab: "drafts" | "published";
  basePath: string;
  createLabel: string;
  description: string;
  drafts: AssetLibraryItem[];
  levelLabel: string;
  onRefresh(): void;
  onTabChange(tab: "drafts" | "published"): void;
  phase: string;
  status: string;
  title: string;
  versions: AssetLibraryItem[];
}) {
  const t = useTranslations("Assets");
  const common = useTranslations("Common");
  const items = activeTab === "drafts" ? drafts : versions;
  return <PageFrame
    description={description}
    eyebrow={t("library")}
    levelLabel={levelLabel}
    title={title}
    actions={<Stack direction="row" spacing={1}>
      <Button onClick={onRefresh} startIcon={<RefreshRoundedIcon />} variant="outlined">{common("refresh")}</Button>
      <Button component={Link} href={assetNewHref(basePath)} startIcon={<AddRoundedIcon />} variant="contained">{createLabel}</Button>
    </Stack>}
  >
    {phase === "failure" && <Alert severity="error" sx={{ mb: 2.5 }} action={<Button onClick={onRefresh}>{common("retry")}</Button>}>{status}</Alert>}
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", overflow: "hidden" }}>
      <Tabs onChange={(_, value: "drafts" | "published") => onTabChange(value)} value={activeTab} variant="fullWidth">
        <Tab label={`${t("published")} (${versions.length})`} value="published" />
        <Tab label={`${t("drafts")} (${drafts.length})`} value="drafts" />
      </Tabs>
      <Divider />
      {phase === "loading"
        ? <Stack spacing={1} sx={{ p: 2 }}>{[0, 1, 2].map((item) => <Skeleton height={68} key={item} variant="rounded" />)}</Stack>
        : items.length
          ? <AssetList basePath={basePath} items={items} kind={activeTab === "drafts" ? "draft" : "version"} />
          : <Box sx={{ px: 3, py: { xs: 6, sm: 8 }, textAlign: "center" }}>
            <Typography component="h2" variant="h5">{activeTab === "drafts" ? t("noDraftsTitle") : t("noVersionsTitle")}</Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>{activeTab === "drafts" ? t("noDraftsDescription") : t("noVersionsDescription")}</Typography>
            {activeTab === "drafts" && <Button component={Link} href={assetNewHref(basePath)} startIcon={<AddRoundedIcon />} sx={{ mt: 2.5 }} variant="contained">{createLabel}</Button>}
          </Box>}
    </Paper>
  </PageFrame>;
}

function AssetList({ basePath, items, kind }: { basePath: string; items: AssetLibraryItem[]; kind: "draft" | "version" }) {
  return <List disablePadding>{items.map((item, index) => <Box key={item.id}>
    {index > 0 && <Divider />}
    <ListItemButton component={Link} href={kind === "draft" ? assetDraftHref(basePath, item.id) : assetVersionHref(basePath, item.id)} sx={{ alignItems: "flex-start", px: { xs: 2, sm: 3 }, py: 2 }}>
      <ListItemText
        primary={item.title}
        secondary={<Stack component="span" direction={{ xs: "column", sm: "row" }} spacing={{ xs: .25, sm: 1.5 }} sx={{ mt: .5 }}><Typography color="text.secondary" component="span" sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: ".72rem", wordBreak: "break-word" }}>{item.detail}</Typography>{item.timestamp && <Typography color="text.secondary" component="span" variant="caption">{formatTimestamp(item.timestamp)}</Typography>}</Stack>}
        slotProps={{ primary: { sx: { fontSize: ".95rem", fontWeight: 680 } } }}
      />
    </ListItemButton>
  </Box>)}</List>;
}

function PageFrame({ actions, children, description, eyebrow, levelLabel, title }: { actions?: ReactNode; children: ReactNode; description: string; eyebrow: string; levelLabel: string; title: string }) {
  return <Box component="main" sx={{ maxWidth: 1180, mx: "auto", p: { xs: 2, sm: 3, lg: 5 } }}>
    <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ alignItems: { md: "flex-end" }, justifyContent: "space-between", mb: 3.5 }}>
      <Box sx={{ maxWidth: 760 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography color="primary.main" variant="overline">{levelLabel}</Typography>
          <Typography aria-hidden color="text.disabled" variant="overline">/</Typography>
          <Typography color="text.secondary" variant="overline">{eyebrow}</Typography>
        </Stack>
        <Typography component="h1" sx={{ mt: .5, textWrap: "balance" }} variant="h1">{title}</Typography>
        <Typography color="text.secondary" sx={{ fontSize: "1rem", lineHeight: 1.65, mt: 1.25, textWrap: "pretty" }}>{description}</Typography>
      </Box>
      {actions && <Box sx={{ flexShrink: 0 }}>{actions}</Box>}
    </Stack>
    {children}
  </Box>;
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
