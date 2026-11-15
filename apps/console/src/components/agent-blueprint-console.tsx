"use client";

import { Autocomplete, Button, Stack, TextField } from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { publishedAssetDetails } from "./assets/published-version-details";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: {
  agentBlueprints: Record<"list" | "saveDraft" | "publish", Procedure>;
  agentsMd: Record<"list", Procedure>;
  mcpPolicies: Record<"list", Procedure>;
  skills: Record<"list", Procedure>;
} };
type Option = { versionRef: string; name: string };
type Draft = {
  blueprintId: string;
  name: string;
  agentsMdVersionRef: string;
  mcpPolicyVersionRef: string;
  skillVersionRefs: string[];
  /** Legacy v1 blueprints retain this field; new drafts delegate Context access to the Environment version. */
  contexts: Record<string, never>;
  revision: number;
  updatedAt?: string;
};
type Version = Omit<Draft, "revision" | "updatedAt"> & { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number };

const api = () => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;
const library = <T,>(value: unknown) => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    drafts: Array.isArray(record.drafts) ? record.drafts as T[] : [],
    versions: Array.isArray(record.versions) ? record.versions as T[] : [],
  };
};

export function AgentBlueprintConsole() {
  const t = useTranslations("Assets");
  const client = useMemo(api, []);
  const blank = useCallback((): Draft => ({
    blueprintId: "",
    name: t("agentBlueprintUntitled"),
    agentsMdVersionRef: "",
    mcpPolicyVersionRef: "",
    skillVersionRefs: [],
    contexts: {},
    revision: 0,
  }), [t]);
  const [machine, send] = useMachine(assetEditorMachine);
  const [draft, setDraft] = useState(blank);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [personas, setPersonas] = useState<Option[]>([]);
  const [environments, setEnvironments] = useState<Option[]>([]);
  const [skills, setSkills] = useState<Option[]>([]);
  const [status, setStatus] = useState(t("agentBlueprintLoading"));

  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try {
      const [blueprintValue, personaValue, environmentValue, skillValue] = await Promise.all([
        client.console.agentBlueprints.list.query({}),
        client.console.agentsMd.list.query({}),
        client.console.mcpPolicies.list.query({}),
        client.console.skills.list.query({}),
      ]);
      const next = library<Draft & Version>(blueprintValue);
      setDrafts(next.drafts);
      setVersions(next.versions);
      setPersonas(library<Option>(personaValue).versions);
      setEnvironments(library<Option>(environmentValue).versions);
      setSkills(library<Option>(skillValue).versions);
      setStatus(t("agentBlueprintReady"));
      send({ type: "LOADED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("agentBlueprintLoadFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }, [client, send, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function save() {
    try {
      const { blueprintId, name, revision, updatedAt: _updatedAt, ...definition } = draft;
      const saved = await client.console.agentBlueprints.saveDraft.mutate({
        ...(blueprintId ? { blueprintId, expectedRevision: revision } : {}),
        name,
        definition,
      }) as Draft;
      setDraft(saved);
      await refresh();
      return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("agentBlueprintSaveFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
      return undefined;
    }
  }

  async function publish() {
    send({ type: "PUBLISH" });
    const saved = await save();
    if (!saved) return;
    try {
      const version = await client.console.agentBlueprints.publish.mutate({ blueprintId: saved.blueprintId, expectedRevision: saved.revision }) as Version;
      setStatus(t("publishedRef", { versionRef: version.versionRef }));
      await refresh();
      send({ type: "SUCCESS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("agentBlueprintPublishFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }

  const select = (label: string, value: string, options: Option[], onChange: (value: string) => void) =>
    <TextField label={label} onChange={(event) => onChange(event.target.value)} select slotProps={{ select: { native: true } }} value={value}>
      <option value="" />
      {options.map((item) => <option key={item.versionRef} value={item.versionRef}>{item.name} · {item.versionRef}</option>)}
    </TextField>;
  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({ id: item.blueprintId, title: item.name, detail: t("draftRevision", { revision: item.revision }), timestamp: item.updatedAt }));
  const versionItems: AssetLibraryItem<Version>[] = versions.map((item) => ({ id: item.versionRef, title: item.name, detail: `${item.versionRef} · ${item.artifactDigest}`, timestamp: item.publishedAt, data: item }));

  return <AssetStudio
    actions={<Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={() => void save()} variant="outlined">{t("saveDraft")}</Button><Button onClick={() => send({ type: "REQUEST_PUBLISH" })} variant="contained">{t("publishVersion")}</Button></Stack>}
    createLabel={t("agentBlueprintNew")}
    description={t("agentBlueprintDescriptionV2")}
    drafts={draftItems}
    editor={<Stack spacing={2}>
      <TextField label={t("name")} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} value={draft.name} />
      {select(t("personaVersion"), draft.agentsMdVersionRef, personas, (agentsMdVersionRef) => setDraft((value) => ({ ...value, agentsMdVersionRef })))}
      <Autocomplete
        getOptionLabel={(option) => `${option.name} · ${option.versionRef}`}
        multiple
        onChange={(_, selected) => setDraft((value) => ({ ...value, skillVersionRefs: selected.map((item) => item.versionRef) }))}
        options={skills}
        renderInput={(params) => <TextField {...params} label={t("skillVersions")} />}
        value={skills.filter((item) => draft.skillVersionRefs.includes(item.versionRef))}
      />
      {select(t("environmentVersion"), draft.mcpPolicyVersionRef, environments, (mcpPolicyVersionRef) => setDraft((value) => ({ ...value, mcpPolicyVersionRef })))}
    </Stack>}
    onCancelPublish={() => send({ type: "DISMISS" })}
    onConfirmPublish={() => void publish()}
    onCreate={() => { setDraft(blank()); send({ type: "EDIT" }); }}
    onCreateFromVersion={(item) => {
      const found = versions.find((value) => value.versionRef === item.id);
      if (!found) return;
      const { versionRef: _versionRef, artifactDigest: _artifactDigest, publishedAt: _publishedAt, draftRevision: _draftRevision, ...definition } = found;
      setDraft({ ...definition, blueprintId: "", name: t("draftFromName", { name: found.name }), revision: 0 });
      send({ type: "EDIT" });
    }}
    onRefresh={() => void refresh()}
    onSelectDraft={(item) => { const found = drafts.find((value) => value.blueprintId === item.id); if (found) setDraft(found); }}
    phase={machine.value as string}
    publishDescription={t("agentBlueprintPublishDescription")}
    publishOpen={machine.matches("confirmingPublish")}
    publishTitle={t("agentBlueprintPublishTitle", { title: draft.name || t("agentBlueprintUntitled") })}
    renderVersionDetails={publishedAssetDetails("agentBlueprint")}
    selectedDraftId={draft.blueprintId}
    status={status}
    title={t("agentBlueprintTitle")}
    versions={versionItems}
  />;
}
