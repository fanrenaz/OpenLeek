"use client";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import {
  Box, Button, Checkbox, Chip, Divider, FormControlLabel, Paper, Stack, TextField, Typography,
} from "@mui/material";
import { type McpResourceId, type McpToolId, type SkillFile, type SkillRequirements } from "@openleek/contracts/agent";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { publishedAssetDetails } from "./assets/published-version-details";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { skills: Record<"list" | "draft" | "version" | "saveDraft" | "validate" | "publish", Procedure> } };
type Draft = {
  skillId: string; name: string; skillName: string; description: string; files: SkillFile[];
  requirements: SkillRequirements; revision: number; updatedAt?: string;
};
type Version = Omit<Draft, "revision" | "updatedAt"> & { versionRef: string; artifactDigest: string; publishedAt: string; draftRevision: number };

const capabilities = {
  tools: [
    "social.get_feed", "social.get_post", "social.list_posts", "social.search_posts",
    "social.get_profile", "social.list_relationships", "social.list_engagements", "social.get_notifications",
    "social.create_post", "social.like_post", "social.repost_post", "social.reply_to_post",
    "social.follow", "social.unfollow", "social.engage",
    "financial.place_order", "financial.cancel_order",
  ] as McpToolId[],
  resources: ["social.feed", "social.profile", "social.posts", "financial.market", "financial.account", "financial.orders"] as McpResourceId[],
};
const api = (): Client => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;
const starter = `---
name: new-skill
description: Describe when this skill should be used.
---

# New skill

Follow this workflow when the task matches the description.
`;
const blank = (name: string): Draft => ({
  skillId: "", name, skillName: "new-skill", description: "", revision: 0,
  files: [{ path: "SKILL.md", encoding: "utf8", content: starter, executable: false }],
  requirements: { tools: [], resources: [] },
});
function library(value: unknown): { drafts: Draft[]; versions: Version[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { drafts: Array.isArray(record.drafts) ? record.drafts as Draft[] : [], versions: Array.isArray(record.versions) ? record.versions as Version[] : [] };
}

export function SkillConsole() {
  const t = useTranslations("Skills");
  const policyT = useTranslations("McpPolicies");
  const client = useMemo(api, []);
  const [machine, send] = useMachine(assetEditorMachine);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState(() => blank(t("untitled")));
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [status, setStatus] = useState(() => t("loading"));
  const zipInput = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try {
      const next = library(await client.console.skills.list.query({}));
      setDrafts(next.drafts); setVersions(next.versions); setStatus(t("ready")); send({ type: "LOADED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("loadFailed"); setStatus(message); send({ type: "FAIL", error: message });
    }
  }, [client, send, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  const edit = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); send({ type: "EDIT" }); };
  const selected = draft.files.find((file) => file.path === selectedPath);
  const saveDraft = async () => {
    try {
      const saved = await client.console.skills.saveDraft.mutate({
        ...(draft.skillId ? { skillId: draft.skillId, expectedRevision: draft.revision } : {}),
        name: draft.name, files: draft.files, requirements: draft.requirements,
      }) as Draft;
      setDraft(saved); setSelectedPath(saved.files.some((file) => file.path === selectedPath) ? selectedPath : "SKILL.md");
      await refresh(); setStatus(t("saved", { revision: saved.revision })); return saved;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("saveFailed"); setStatus(message); send({ type: "FAIL", error: message }); return undefined;
    }
  };
  const save = async () => { send({ type: "SAVE" }); if (await saveDraft()) send({ type: "SUCCESS" }); };
  const publish = async () => {
    send({ type: "PUBLISH" }); const saved = await saveDraft(); if (!saved) return;
    try {
      const version = await client.console.skills.publish.mutate({ skillId: saved.skillId, expectedRevision: saved.revision }) as Version;
      await refresh(); setStatus(t("published", { versionRef: version.versionRef })); send({ type: "SUCCESS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("publishFailed"); setStatus(message); send({ type: "FAIL", error: message });
    }
  };
  const addFile = () => {
    const path = newPath.trim();
    if (!path || draft.files.some((file) => file.path.toLowerCase() === path.toLowerCase())) return;
    const file = { path, encoding: "utf8", content: "", executable: false } satisfies SkillFile;
    edit({ files: [...draft.files, file].sort((a, b) => a.path.localeCompare(b.path)) });
    setSelectedPath(path); setNewPath("");
  };
  const updateSelected = (patch: Partial<SkillFile>) => {
    edit({ files: draft.files.map((file) => file.path === selectedPath ? { ...file, ...patch } : file) });
  };
  const importZip = async (file: File) => {
    try {
      const imported = zipFiles(new Uint8Array(await file.arrayBuffer()));
      edit({ files: imported }); setSelectedPath("SKILL.md"); setStatus(t("imported", { count: imported.length }));
    } catch (error) { setStatus(error instanceof Error ? error.message : t("importFailed")); send({ type: "FAIL", error: String(error) }); }
  };
  const exportZip = () => {
    const data: Zippable = Object.fromEntries(draft.files.map((file) => [file.path, [
      file.encoding === "base64" ? Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)) : strToU8(file.content),
      { os: 3, attrs: (file.executable ? 0o755 : 0o644) << 16 },
    ] as Zippable[string]]));
    const blob = new Blob([zipSync(data, { level: 6 }) as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${draft.skillName || "skill"}.zip`; anchor.click(); URL.revokeObjectURL(url);
  };
  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({
    id: item.skillId, title: item.name,
    detail: t("draftRevision", { revision: item.revision }),
    timestamp: item.updatedAt, data: item,
  }));
  const versionItems: AssetLibraryItem<Version>[] = versions.map((item) => ({
    id: item.versionRef, title: item.name,
    detail: `${item.versionRef} · ${item.artifactDigest}`,
    timestamp: item.publishedAt, data: item,
  }));

  return <AssetStudio
    level="individual"
    title={t("title")} description={t("description")} status={status} phase={machine.value as string}
    drafts={draftItems} versions={versionItems} selectedDraftId={draft.skillId} onRefresh={() => void refresh()}
    onCreate={() => { setDraft(blank(t("untitled"))); setSelectedPath("SKILL.md"); send({ type: "EDIT" }); }} createLabel={t("new")}
    onSelectDraft={(item) => { const found = drafts.find((value) => value.skillId === item.id); if (found) { setDraft(structuredClone(found)); setSelectedPath("SKILL.md"); } }}
    onCreateFromVersion={(item) => { const found = versions.find((value) => value.versionRef === item.id); if (found) { setDraft({ ...structuredClone(found), skillId: "", name: t("draftFromName", { name: found.name }), revision: 0 }); setSelectedPath("SKILL.md"); send({ type: "EDIT" }); } }}
    renderVersionDetails={publishedAssetDetails("skill")}
    editor={<Stack spacing={2.5}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
        <TextField fullWidth label={t("name")} value={draft.name} onChange={(event) => edit({ name: event.target.value })} />
        <Button startIcon={<UploadFileRoundedIcon />} onClick={() => zipInput.current?.click()} variant="outlined">{t("importZip")}</Button>
        <Button startIcon={<DownloadRoundedIcon />} onClick={exportZip} variant="outlined">{t("exportZip")}</Button>
        <input ref={zipInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importZip(file); event.target.value = ""; }} />
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "260px minmax(0, 1fr)" }, gap: 2 }}>
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <Box sx={{ p: 1.5 }}><Typography variant="subtitle2">{t("files")}</Typography></Box><Divider />
          <Stack sx={{ maxHeight: 520, overflow: "auto", p: 1 }}>
            {draft.files.map((file) => <Button key={file.path} onClick={() => setSelectedPath(file.path)} sx={{ justifyContent: "flex-start", textTransform: "none" }} variant={selectedPath === file.path ? "contained" : "text"}>{file.path}</Button>)}
          </Stack>
          <Divider /><Stack direction="row" spacing={1} sx={{ p: 1.5 }}><TextField size="small" label={t("newPath")} value={newPath} onChange={(event) => setNewPath(event.target.value)} /><Button aria-label={t("addFile")} onClick={addFile}><AddRoundedIcon /></Button></Stack>
        </Paper>
        <Paper variant="outlined" sx={{ minWidth: 0, p: 2 }}>
          {selected ? <Stack spacing={1.5}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
              <Box><Typography sx={{ fontFamily: "monospace" }}>{selected.path}</Typography><Chip label={selected.encoding} size="small" /></Box>
              <Stack direction="row"><FormControlLabel control={<Checkbox checked={selected.executable} onChange={(event) => updateSelected({ executable: event.target.checked })} />} label={t("executable")} />
                <Button color="error" disabled={selected.path === "SKILL.md"} startIcon={<DeleteOutlineRoundedIcon />} onClick={() => { edit({ files: draft.files.filter((file) => file.path !== selected.path) }); setSelectedPath("SKILL.md"); }}>{t("remove")}</Button></Stack>
            </Stack>
            {selected.encoding === "utf8"
              ? <TextField minRows={18} multiline value={selected.content} onChange={(event) => updateSelected({ content: event.target.value })} slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }} />
              : <Stack><Typography color="text.secondary">{t("binaryFile")}</Typography><Button onClick={() => replacementInput.current?.click()} variant="outlined">{t("replaceBinary")}</Button></Stack>}
            <input ref={replacementInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.arrayBuffer().then((buffer) => updateSelected({ encoding: "base64", content: bytesToBase64(new Uint8Array(buffer)) })); event.target.value = ""; }} />
          </Stack> : null}
        </Paper>
      </Box>
      <Box><Typography variant="h6">{t("requirements")}</Typography><Typography color="text.secondary" variant="body2">{t("requirementsHelp")}</Typography></Box>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2">{policyT("tools")}</Typography>
        {capabilities.tools.map((value) => <FormControlLabel key={value} control={<Checkbox checked={draft.requirements.tools.includes(value)} onChange={() => edit({ requirements: { ...draft.requirements, tools: toggle(draft.requirements.tools, value) } })} />} label={policyT(`capabilities.${value}`)} />)}
        <Typography sx={{ mt: 1.5 }} variant="subtitle2">{policyT("resources")}</Typography>
        {capabilities.resources.map((value) => <FormControlLabel key={value} control={<Checkbox checked={draft.requirements.resources.includes(value)} onChange={() => edit({ requirements: { ...draft.requirements, resources: toggle(draft.requirements.resources, value) } })} />} label={policyT(`capabilities.${value}`)} />)}
      </Paper>
    </Stack>}
    actions={<Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}><Button onClick={() => void save()} variant="outlined">{t("save")}</Button><Button onClick={() => send({ type: "REQUEST_PUBLISH" })} variant="contained">{t("publish")}</Button></Stack>}
    publishOpen={machine.matches("confirmingPublish")} onCancelPublish={() => send({ type: "DISMISS" })} onConfirmPublish={() => void publish()} publishTitle={t("publishTitle")} publishDescription={t("publishDescription")}
  />;
}

function toggle<T>(values: T[], value: T): T[] { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function zipFiles(bytes: Uint8Array): SkillFile[] {
  const attributes = inspectZip(bytes);
  const entries = Object.entries(unzipSync(bytes)).filter(([path]) => !path.endsWith("/"));
  if (!entries.length || entries.length > 200) throw new Error("ZIP must contain between 1 and 200 files.");
  const paths = entries.map(([path]) => path.replaceAll("\\", "/"));
  const roots = new Set(paths.filter((path) => path.includes("/")).map((path) => path.split("/")[0]));
  const hasRootSkill = paths.includes("SKILL.md");
  const prefix = !hasRootSkill && roots.size === 1 ? `${[...roots][0]}/` : "";
  const normalized = entries.map(([rawPath, content]) => {
    const path = rawPath.replaceAll("\\", "/").slice(prefix.length);
    return { path, rawPath: rawPath.replaceAll("\\", "/"), content };
  });
  if (!normalized.some(({ path }) => path === "SKILL.md")) throw new Error("ZIP must contain SKILL.md at its root or inside one enclosing directory.");
  return normalized.map(({ path, rawPath, content }) => {
    const executable = attributes.get(rawPath) ?? path.startsWith("scripts/");
    try {
      const text = strFromU8(content, true);
      if (text.includes("\0")) throw new Error();
      return { path, encoding: "utf8" as const, content: text, executable };
    } catch {
      return { path, encoding: "base64" as const, content: bytesToBase64(content), executable };
    }
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function inspectZip(bytes: Uint8Array): Map<string, boolean> {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("ZIP must not exceed 20 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = Math.max(0, bytes.byteLength - 65_557); offset <= bytes.byteLength - 22; offset++) {
    if (view.getUint32(offset, true) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error("ZIP central directory is missing.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count < 1 || count > 200) throw new Error("ZIP must contain between 1 and 200 entries.");
  let total = 0;
  const result = new Map<string, boolean>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP central directory is malformed.");
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    if (size === 0xffffffff) throw new Error("ZIP64 bundles are not supported.");
    total += size;
    if (size > 2 * 1024 * 1024 || total > 10 * 1024 * 1024) throw new Error("ZIP exceeds the Skill bundle size limits.");
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength)).replaceAll("\\", "/");
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`ZIP symlinks are not allowed: ${name}`);
    result.set(name, Boolean(unixMode & 0o111));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
