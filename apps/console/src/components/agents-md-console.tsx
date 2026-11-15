"use client";

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { publishedAssetDetails } from "./assets/published-version-details";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { agentsMd: Record<"list" | "draft" | "version", Procedure> & Record<"saveDraft" | "publish", Procedure> } };
type Draft = { templateId: string; name: string; source: string; revision: number; updatedAt?: string };
type Version = { versionRef: string; name: string; source: string; artifactDigest: string; publishedAt: string; draftRevision: number };

function api(): Client { return createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client; }
function library(value: unknown): { drafts: Draft[]; versions: Version[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { drafts: Array.isArray(record.drafts) ? record.drafts as Draft[] : [], versions: Array.isArray(record.versions) ? record.versions as Version[] : [] };
}
const blank = (name: string): Draft => ({ templateId: "", name, source: "# Agent\n", revision: 0 });

/** Console control surface for verbatim, immutable AGENTS.md source artifacts. */
export function AgentsMdConsole() {
  const client = useMemo(api, []);
  const t = useTranslations("Assets");
  const [editor, send] = useMachine(assetEditorMachine);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState<Draft>(() => blank(t("agentsUntitled")));
  const [status, setStatus] = useState(() => t("agentsLoading"));
  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try { const next = library(await client.console.agentsMd.list.query({})); setDrafts(next.drafts); setVersions(next.versions); setStatus(t("agentsReady")); send({ type: "LOADED" }); }
    catch (error) { const message = error instanceof Error ? error.message : t("agentsLoadFailed"); setStatus(message); send({ type: "FAIL", error: message }); }
  }, [client, send, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  function edit(change: (current: Draft) => Draft) { setDraft(change); send({ type: "EDIT" }); }
  async function saveDraft() {
    try {
      const saved = await client.console.agentsMd.saveDraft.mutate({ ...(draft.templateId ? { templateId: draft.templateId, expectedRevision: draft.revision } : {}), name: draft.name, source: draft.source }) as Draft;
      setDraft(saved); await refresh(); setStatus(t("agentsDraftSaved", { revision: saved.revision })); return saved;
    } catch (error) { const message = error instanceof Error ? error.message : t("agentsDraftSaveFailed"); setStatus(message); send({ type: "FAIL", error: message }); return undefined; }
  }
  async function save() { send({ type: "SAVE" }); const saved = await saveDraft(); if (saved) send({ type: "SUCCESS" }); }
  async function publish() {
    send({ type: "PUBLISH" }); const saved = await saveDraft(); if (!saved) return;
    try { const version = await client.console.agentsMd.publish.mutate({ templateId: saved.templateId, expectedRevision: saved.revision }) as Version; setStatus(t("agentsPublished", { versionRef: version.versionRef })); await refresh(); send({ type: "SUCCESS" }); }
    catch (error) { const message = error instanceof Error ? error.message : t("agentsPublishFailed"); setStatus(message); send({ type: "FAIL", error: message }); }
  }
  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({ id: item.templateId, title: item.name, detail: `draft r${item.revision} · ${item.templateId}`, timestamp: item.updatedAt, data: item }));
  const versionItems: AssetLibraryItem<Version>[] = versions.map((item) => ({ id: item.versionRef, title: item.name, detail: `${item.versionRef} · ${item.artifactDigest}`, timestamp: item.publishedAt, data: item }));
  return <AssetStudio
    level="individual"
    createLabel={t("newTemplate")} description={t("agentsDescription")} drafts={draftItems} versions={versionItems}
    editor={<Stack spacing={2.5}><Box><Typography component="h2" variant="h5">{draft.name || t("agentsUntitled")}</Typography><Typography color="text.secondary" variant="body2">{draft.templateId ? t("draftRevision", { revision: draft.revision }) : t("unsavedDraft")}</Typography></Box><TextField fullWidth label={t("name")} onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))} value={draft.name} /><TextField fullWidth helperText={t("rawAgentsHelp")} label={t("rawAgentsSource")} minRows={18} multiline onChange={(event) => edit((current) => ({ ...current, source: event.target.value }))} value={draft.source} /></Stack>}
    actions={<Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ justifyContent: "flex-end" }}><Button disabled={editor.matches("saving") || editor.matches("publishing")} onClick={() => void save()} variant="outlined">{t("saveDraft")}</Button><Button disabled={editor.matches("saving") || editor.matches("publishing")} onClick={() => send({ type: "REQUEST_PUBLISH" })} variant="contained">{t("publishVersion")}</Button></Stack>}
    onCancelPublish={() => send({ type: "DISMISS" })} onConfirmPublish={() => void publish()} onCreate={() => { setDraft(blank(t("agentsUntitled"))); setStatus(t("agentsNewDraft")); send({ type: "EDIT" }); }} onRefresh={() => void refresh()} onSelectDraft={(item) => { const found = drafts.find((candidate) => candidate.templateId === item.id); if (found) { setDraft({ ...found }); setStatus(t("agentsEditing", { name: found.name })); } }} onCreateFromVersion={(item) => { const found = versions.find((candidate) => candidate.versionRef === item.id); if (found) { setDraft({ templateId: "", name: t("draftFromName", { name: found.name }), source: found.source, revision: 0 }); setStatus(t("agentsFromVersion", { versionRef: found.versionRef })); send({ type: "EDIT" }); } }} renderVersionDetails={publishedAssetDetails("agents-md")} phase={editor.value as string} publishDescription={t("agentsPublishDescription")} publishOpen={editor.matches("confirmingPublish")} publishTitle={t("agentsPublishTitle")} selectedDraftId={draft.templateId} status={status} title={t("agentsTitle")} />;
}
