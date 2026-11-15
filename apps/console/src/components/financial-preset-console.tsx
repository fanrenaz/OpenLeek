"use client";

import { Button, MenuItem, Stack, TextField } from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMachine } from "@xstate/react";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { publishedAssetDetails } from "./assets/published-version-details";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { financialInitialStatePresets: Record<"list" | "saveDraft" | "publish", Procedure> } };
type Definition =
  | { mode: "fixed"; cash: number; positions: Record<string, number> }
  | { mode: "deterministic_issuance"; cash: number; symbol: string; issuePrice: number; buckets: Array<{ weight: number; spendCashFraction: number }>; seedSalt: string }
  | { mode: "population_relative"; sourcePresetVersionRefs: string[]; wealthFraction: number; targetAssetValueFraction: number; symbol: string };
type Draft = Definition & { presetId: string; name: string; revision: number; updatedAt?: string };
type Version = Definition & { presetId: string; name: string; versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number };
const api = () => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;
const library = (value: unknown) => { const record = value && typeof value === "object" ? value as Record<string, unknown> : {}; return { drafts: Array.isArray(record.drafts) ? record.drafts as Draft[] : [], versions: Array.isArray(record.versions) ? record.versions as Version[] : [] }; };
const definitionOf = (value: Definition): Definition => value.mode === "fixed"
  ? { mode: "fixed", cash: value.cash, positions: value.positions }
  : value.mode === "deterministic_issuance"
    ? { mode: value.mode, cash: value.cash, symbol: value.symbol, issuePrice: value.issuePrice, buckets: value.buckets, seedSalt: value.seedSalt }
    : { mode: value.mode, sourcePresetVersionRefs: value.sourcePresetVersionRefs, wealthFraction: value.wealthFraction, targetAssetValueFraction: value.targetAssetValueFraction, symbol: value.symbol };
const defaultDefinition = (mode: Definition["mode"]): Definition => mode === "fixed"
  ? { mode, cash: 10_000, positions: {} }
  : mode === "deterministic_issuance"
    ? { mode, cash: 100_000, symbol: "LEEK", issuePrice: 100, buckets: [{ weight: 1, spendCashFraction: 0.5 }], seedSalt: "issuance-v1" }
    : { mode, sourcePresetVersionRefs: [], wealthFraction: 0.3, targetAssetValueFraction: 0.5, symbol: "LEEK" };

export function FinancialPresetConsole() {
  const t = useTranslations("Assets");
  const client = useMemo(api, []);
  const [machine, send] = useMachine(assetEditorMachine);
  const blank = useCallback((): Draft => ({ presetId: "", name: t("financialPresetUntitled"), ...defaultDefinition("fixed"), revision: 0 }), [t]);
  const [draft, setDraft] = useState(blank);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [definitionText, setDefinitionText] = useState(() => JSON.stringify(definitionOf(blank()), null, 2));
  const [status, setStatus] = useState(t("financialPresetLoading"));
  const refresh = useCallback(async () => { send({ type: "LOAD" }); try { const next = library(await client.console.financialInitialStatePresets.list.query({})); setDrafts(next.drafts); setVersions(next.versions); setStatus(t("financialPresetReady")); send({ type: "LOADED" }); } catch (error) { const message = error instanceof Error ? error.message : t("financialPresetLoadFailed"); setStatus(message); send({ type: "FAIL", error: message }); } }, [client, send, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async () => { try { const definition = JSON.parse(definitionText) as Definition; const saved = await client.console.financialInitialStatePresets.saveDraft.mutate({ ...(draft.presetId ? { presetId: draft.presetId, expectedRevision: draft.revision } : {}), name: draft.name, definition }) as Draft; setDraft(saved); setDefinitionText(JSON.stringify(definitionOf(saved), null, 2)); await refresh(); return saved; } catch (error) { const message = error instanceof Error ? error.message : t("financialPresetSaveFailed"); setStatus(message); send({ type: "FAIL", error: message }); } };
  const publish = async () => { send({ type: "PUBLISH" }); const saved = await save(); if (!saved) return; try { const version = await client.console.financialInitialStatePresets.publish.mutate({ presetId: saved.presetId, expectedRevision: saved.revision }) as Version; setStatus(t("publishedRef", { versionRef: version.versionRef })); await refresh(); send({ type: "SUCCESS" }); } catch (error) { const message = error instanceof Error ? error.message : t("financialPresetPublishFailed"); setStatus(message); send({ type: "FAIL", error: message }); } };
  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({ id: item.presetId, title: item.name, detail: t("draftRevision", { revision: item.revision }), timestamp: item.updatedAt }));
  const versionItems: AssetLibraryItem<Version>[] = versions.map((item) => ({ id: item.versionRef, title: item.name, detail: `${item.versionRef} · ${item.artifactDigest}`, timestamp: item.publishedAt, data: item }));
  return <AssetStudio title={t("financialPresetTitle")} description={t("financialPresetDescription")} status={status} phase={machine.value as string} drafts={draftItems} versions={versionItems} selectedDraftId={draft.presetId} onRefresh={() => void refresh()} onCreate={() => { const next = blank(); setDraft(next); setDefinitionText(JSON.stringify(definitionOf(next), null, 2)); send({ type: "EDIT" }); }} createLabel={t("financialPresetNew")} onSelectDraft={(item) => { const found = drafts.find((value) => value.presetId === item.id); if (found) { setDraft(found); setDefinitionText(JSON.stringify(definitionOf(found), null, 2)); } }} onCreateFromVersion={(item) => { const found = versions.find((value) => value.versionRef === item.id); if (found) { const next = { presetId: "", name: t("draftFromName", { name: found.name }), ...definitionOf(found), revision: 0 } as Draft; setDraft(next); setDefinitionText(JSON.stringify(definitionOf(next), null, 2)); send({ type: "EDIT" }); } }} renderVersionDetails={publishedAssetDetails("financialPreset")} editor={<Stack spacing={2}><TextField label={t("name")} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /><TextField select label={t("financialPresetMode")} value={draft.mode} onChange={(event) => { const definition = defaultDefinition(event.target.value as Definition["mode"]); const next = { presetId: draft.presetId, name: draft.name, revision: draft.revision, ...definition } as Draft; setDraft(next); setDefinitionText(JSON.stringify(definition, null, 2)); }}><MenuItem value="fixed">{t("financialPresetFixed")}</MenuItem><MenuItem value="deterministic_issuance">{t("financialPresetIssuance")}</MenuItem><MenuItem value="population_relative">{t("financialPresetPopulationRelative")}</MenuItem></TextField><TextField label={t("financialPresetDefinitionJson")} multiline minRows={12} value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} /></Stack>} actions={<Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button variant="outlined" onClick={() => void save()}>{t("saveDraft")}</Button><Button variant="contained" onClick={() => send({ type: "REQUEST_PUBLISH" })}>{t("publishVersion")}</Button></Stack>} publishOpen={machine.matches("confirmingPublish")} onCancelPublish={() => send({ type: "DISMISS" })} onConfirmPublish={() => void publish()} publishTitle={t("financialPresetPublishTitle", { title: draft.name || t("financialPresetUntitled") })} publishDescription={t("financialPresetPublishDescription")} />;
}
