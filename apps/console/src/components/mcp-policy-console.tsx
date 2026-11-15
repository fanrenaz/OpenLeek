"use client";

import { Button, Checkbox, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from "@mui/material";
import { type McpResourceId, type McpToolId } from "@openleek/contracts/agent";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { publishedAssetDetails } from "./assets/published-version-details";
import { localized, useConsoleContexts } from "./ui/settings-dialog";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { mcpPolicies: Record<"list" | "draft" | "version" | "saveDraft" | "publish", Procedure> } };
type EnvironmentBinding = { enabled: boolean; accountPolicy: Record<string, unknown> };
type Draft = { policyId: string; name: string; tools: McpToolId[]; resources: McpResourceId[]; contexts: Record<string, EnvironmentBinding>; revision: number; updatedAt?: string };
type Version = Omit<Draft, "revision" | "updatedAt"> & { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number };

const api = (): Client => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;
const blank = (name: string): Draft => ({ policyId: "", name, tools: [], resources: [], contexts: {}, revision: 0 });
function library(value: unknown): { drafts: Draft[]; versions: Version[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalize = <T extends Partial<Draft>>(item: T): T & { contexts: Record<string, EnvironmentBinding> } => ({ ...item, contexts: item.contexts ?? {} });
  return {
    drafts: Array.isArray(record.drafts) ? (record.drafts as Draft[]).map(normalize) : [],
    versions: Array.isArray(record.versions) ? (record.versions as Version[]).map(normalize) : [],
  };
}

export function McpPolicyConsole() {
  const t = useTranslations("McpPolicies");
  const locale = useLocale();
  const { visibleContexts } = useConsoleContexts();
  const client = useMemo(api, []);
  const [machine, send] = useMachine(assetEditorMachine);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState(() => blank(t("untitled")));
  const [status, setStatus] = useState(() => t("loading"));

  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try {
      const next = library(await client.console.mcpPolicies.list.query({}));
      setDrafts(next.drafts);
      setVersions(next.versions);
      setStatus(t("ready"));
      send({ type: "LOADED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("loadFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }, [client, send, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  const edit = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); send({ type: "EDIT" }); };
  const toggle = <T extends McpToolId | McpResourceId>(values: T[], value: T): T[] =>
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

  const saveDraft = async () => {
    try {
      const saved = await client.console.mcpPolicies.saveDraft.mutate({
        ...(draft.policyId ? { policyId: draft.policyId, expectedRevision: draft.revision } : {}),
        name: draft.name,
        tools: draft.tools,
        resources: draft.resources,
        contexts: draft.contexts,
      }) as Draft;
      setDraft(saved);
      await refresh();
      setStatus(t("saved", { revision: saved.revision }));
      return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("saveFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
      return undefined;
    }
  };
  const save = async () => { send({ type: "SAVE" }); if (await saveDraft()) send({ type: "SUCCESS" }); };
  const publish = async () => {
    send({ type: "PUBLISH" });
    const saved = await saveDraft();
    if (!saved) return;
    try {
      const version = await client.console.mcpPolicies.publish.mutate({ policyId: saved.policyId, expectedRevision: saved.revision }) as Version;
      await refresh();
      setStatus(t("published", { versionRef: version.versionRef }));
      send({ type: "SUCCESS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("publishFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  };

  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({
    id: item.policyId,
    title: item.name,
    detail: t("draftRevision", { revision: item.revision }),
    timestamp: item.updatedAt,
    data: item,
  }));
  const versionItems: AssetLibraryItem<Version>[] = versions.map((item) => ({
    id: item.versionRef,
    title: item.name,
    detail: `${item.versionRef} · ${item.artifactDigest}`,
    timestamp: item.publishedAt,
    data: item,
  }));

  return <AssetStudio
    level="individual"
    title={t("title")}
    description={t("description")}
    status={status}
    phase={machine.value as string}
    drafts={draftItems}
    versions={versionItems}
    selectedDraftId={draft.policyId}
    onRefresh={() => void refresh()}
    onCreate={() => { setDraft(blank(t("untitled"))); send({ type: "EDIT" }); }}
    createLabel={t("new")}
    onSelectDraft={(item) => { const found = drafts.find((value) => value.policyId === item.id); if (found) setDraft(structuredClone(found)); }}
    onCreateFromVersion={(item) => {
      const found = versions.find((value) => value.versionRef === item.id);
      if (found) {
        setDraft({ policyId: "", name: t("draftFromName", { name: found.name }), tools: [...found.tools], resources: [...found.resources], contexts: structuredClone(found.contexts), revision: 0 });
        send({ type: "EDIT" });
      }
    }}
    renderVersionDetails={publishedAssetDetails("mcp-policy")}
    editor={<Stack spacing={2.5}>
      <TextField label={t("name")} value={draft.name} onChange={(event) => edit({ name: event.target.value })} />
      {visibleContexts.map((context) => {
        const binding = draft.contexts[context.contextId] ?? { enabled: false, accountPolicy: {} };
        const tools = context.agentEnvironment?.capabilities?.filter((item) => item.kind === "tool") ?? [];
        const resources = context.agentEnvironment?.capabilities?.filter((item) => item.kind === "resource") ?? [];
        const updateBinding = (next: EnvironmentBinding) => edit({ contexts: { ...draft.contexts, [context.contextId]: next } });
        return <Paper key={context.contextId} variant="outlined" sx={{ p: 2.5 }}>
        <Stack spacing={2}>
          <FormControlLabel
            control={<Switch checked={binding.enabled} onChange={(event) => updateBinding({ ...binding, enabled: event.target.checked })} />}
            label={<Typography variant="h6">{localized(context.label, locale)}</Typography>}
          />
          {binding.enabled ? <>
          <TextField
            defaultValue={JSON.stringify(binding.accountPolicy, null, 2)}
            helperText={t("accountPolicyHelp")}
            key={`${draft.policyId}:${draft.revision}:${context.contextId}`}
            label={t("accountPolicy")}
            minRows={3}
            multiline
            onBlur={(event) => {
              try { updateBinding({ ...binding, accountPolicy: JSON.parse(event.target.value) as Record<string, unknown> }); } catch { setStatus(t("accountPolicyInvalid")); }
            }}
          />
          <Stack>
            <Typography color="text.secondary" variant="subtitle2">{t("tools")}</Typography>
            {tools.map((tool) => <FormControlLabel key={tool.id} control={<Checkbox checked={draft.tools.includes(tool.id)} onChange={() => edit({ tools: toggle(draft.tools, tool.id) })} />} label={localized(tool.label, locale)} />)}
          </Stack>
          <Stack>
            <Typography color="text.secondary" variant="subtitle2">{t("resources")}</Typography>
            {resources.map((resource) => <FormControlLabel key={resource.id} control={<Checkbox checked={draft.resources.includes(resource.id)} onChange={() => edit({ resources: toggle(draft.resources, resource.id) })} />} label={localized(resource.label, locale)} />)}
          </Stack>
          </> : null}
        </Stack>
      </Paper>;
      })}
      {draft.tools.length === 0 && draft.resources.length === 0 ? <Typography color="text.secondary">{t("emptyPolicy")}</Typography> : null}
    </Stack>}
    actions={<Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button variant="outlined" onClick={() => void save()}>{t("save")}</Button><Button variant="contained" onClick={() => send({ type: "REQUEST_PUBLISH" })}>{t("publish")}</Button></Stack>}
    publishOpen={machine.matches("confirmingPublish")}
    onCancelPublish={() => send({ type: "DISMISS" })}
    onConfirmPublish={() => void publish()}
    publishTitle={t("publishTitle")}
    publishDescription={t("publishDescription")}
  />;
}
