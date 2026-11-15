"use client";

import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
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
  FormControlLabel,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { operationMachine } from "../features/shared/operation-machine";
import { ConsolePage, ConsolePageHeader } from "./ui/console-page";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type LlmConfigurationProcedure = Record<"graph", Procedure> & Record<"validate" | "patch" | "createResource" | "deleteResource", Procedure>;
type BrowserConsole = { console: { llmConfiguration: LlmConfigurationProcedure } };
type ConfigField = { path: string; type: string; label: string; secret?: boolean; control?: string; enum?: string[]; required?: boolean; hotReloadable?: boolean };
type ConfigResource = { kind: string; id: string; label: string; value: Record<string, unknown>; schema: { fields: ConfigField[] }; hotReloadable?: boolean; runtimeImpact?: string };
type ConfigGraph = { revision: string; resources: ConfigResource[] };
type ConfigPatchResponse = { result?: string; revision?: string; graph?: ConfigGraph; errors?: Array<{ field?: string; message?: string }> };

const resourceKinds = ["model", "provider", "provider_offer", "route"];

function api(): BrowserConsole { return createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as BrowserConsole; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function configGraph(value: unknown): ConfigGraph | undefined { const candidate = record(value); return typeof candidate.revision === "string" && Array.isArray(candidate.resources) ? candidate as unknown as ConfigGraph : undefined; }
function configResponse(value: unknown): ConfigPatchResponse { return record(value) as ConfigPatchResponse; }
function resourceKey(resource: Pick<ConfigResource, "kind" | "id">) { return `${resource.kind}/${resource.id}`; }
function fieldValue(resource: ConfigResource, field: ConfigField) { return field.path.split(".").reduce<unknown>((current, segment) => record(current)[segment], resource.value); }
function displayFieldValue(value: unknown, field: ConfigField) { if (field.secret && value === "******") return ""; if (value === undefined || value === null) return ""; return field.type === "object" || field.type === "array" ? JSON.stringify(value, null, 2) : String(value); }

function parseFieldValue(field: ConfigField, value: unknown) {
  if (field.type === "boolean") return Boolean(value);
  const text = String(value);
  if (field.type === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`${field.label} must be a number.`);
    return parsed;
  }
  if (field.type === "object" || field.type === "array") {
    const parsed = JSON.parse(text) as unknown;
    if (field.type === "array" && !Array.isArray(parsed)) throw new Error(`${field.label} must be a JSON array.`);
    if (field.type === "object" && (!parsed || Array.isArray(parsed) || typeof parsed !== "object")) throw new Error(`${field.label} must be a JSON object.`);
    return parsed;
  }
  return text;
}

function patchStatus(result: ConfigPatchResponse) {
  if (result.result === "revisionConflict") return "Configuration changed elsewhere. Reload it before saving.";
  if (result.result === "validationRejected" || result.result === "runtimeRejected") return result.errors?.map((error) => error.message).filter(Boolean).join(" ") || "LLM Configuration rejected this configuration.";
  return "Configuration saved.";
}

export function RuntimeConsole() {
  const client = useMemo(api, []);
  const t = useTranslations();
  const [state, send] = useMachine(operationMachine);
  const [graph, setGraph] = useState<ConfigGraph>();
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [newKind, setNewKind] = useState("model");
  const [newResourceId, setNewResourceId] = useState("");
  const [newResourceValue, setNewResourceValue] = useState("{}");
  const [resourceToDelete, setResourceToDelete] = useState<ConfigResource>();
  const busy = state.matches("loading") || state.matches("saving");
  const refresh = useCallback(async (successMessage?: string) => {
    send({ type: "START", message: "Loading LLM configuration…" });
    try {
      const next = configGraph(await client.console.llmConfiguration.graph.query({}));
      if (!next) throw new Error("LLM Configuration returned an invalid configuration graph.");
      setGraph(next);
      setDrafts({});
      send({ type: "SUCCEED", message: successMessage ?? `LLM revision ${next.revision} loaded.` });
    } catch (error) {
      send({ type: "FAIL", message: error instanceof Error ? error.message : "Could not load LLM configuration." });
    }
  }, [client, send]);

  useEffect(() => { void refresh(); }, [refresh]);

  function updateDraft(resource: ConfigResource, field: ConfigField, value: unknown) {
    const id = resourceKey(resource);
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field.path]: value } }));
  }

  async function saveResource(resource: ConfigResource) {
    if (!graph) return;
    const draft = drafts[resourceKey(resource)];
    if (!draft || Object.keys(draft).length === 0) return;
    send({ type: "START", message: `Validating ${resource.label}…` });
    try {
      const changes = Object.entries(draft).map(([fieldPath, value]) => {
        const field = resource.schema.fields.find((candidate) => candidate.path === fieldPath);
        if (!field) throw new Error(`Unknown LLM configuration field ${fieldPath}.`);
        return { kind: resource.kind, id: resource.id, field: field.path, value: parseFieldValue(field, value) };
      });
      const input = { baseRevision: graph.revision, changes };
      const validation = configResponse(await client.console.llmConfiguration.validate.mutate(input));
      if (validation.result !== "committed" && validation.result !== "restartRequired") {
        send({ type: "FAIL", message: patchStatus(validation) });
        return;
      }
      send({ type: "START", message: `Saving ${resource.label}…` });
      const saved = configResponse(await client.console.llmConfiguration.patch.mutate(input));
      if (saved.result !== "committed" && saved.result !== "restartRequired") {
        send({ type: "FAIL", message: patchStatus(saved) });
        return;
      }
      await refresh(patchStatus(saved));
    } catch (error) {
      send({ type: "FAIL", message: error instanceof Error ? error.message : "Could not save LLM configuration." });
    }
  }

  async function deleteResource() {
    if (!graph || !resourceToDelete) return;
    const resource = resourceToDelete;
    setResourceToDelete(undefined);
    send({ type: "START", message: `Deleting ${resource.label}…` });
    try {
      const result = configResponse(await client.console.llmConfiguration.deleteResource.mutate({ kind: resource.kind, id: resource.id, baseRevision: graph.revision }));
      if (result.result !== "committed" && result.result !== "restartRequired") {
        send({ type: "FAIL", message: patchStatus(result) });
        return;
      }
      await refresh(patchStatus(result));
    } catch (error) {
      send({ type: "FAIL", message: error instanceof Error ? error.message : "Could not delete LLM configuration resource." });
    }
  }

  async function createResource() {
    if (!graph) return;
    send({ type: "START", message: "Creating resource…" });
    try {
      const value = JSON.parse(newResourceValue) as unknown;
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("New resource value must be a JSON object.");
      const result = configResponse(await client.console.llmConfiguration.createResource.mutate({ kind: newKind, id: newResourceId.trim(), baseRevision: graph.revision, value }));
      if (result.result !== "committed" && result.result !== "restartRequired") {
        send({ type: "FAIL", message: patchStatus(result) });
        return;
      }
      setNewResourceId("");
      setNewResourceValue("{}");
      await refresh(patchStatus(result));
    } catch (error) {
      send({ type: "FAIL", message: error instanceof Error ? error.message : "Could not create LLM configuration resource." });
    }
  }

  const alertSeverity = state.matches("failure") ? "error" : state.matches("success") ? "success" : "info";
  return <ConsolePage>
    <ConsolePageHeader action={<Button disabled={busy} onClick={() => void refresh()} startIcon={<RefreshRoundedIcon />} variant="outlined">{t("Runtime.reload")}</Button>} description={t("Runtime.description")} title={t("Runtime.title")} />
    <Stack spacing={2.5}>
      <Alert severity={alertSeverity} sx={{ alignItems: "center" }}>{state.context.message || t("Common.loading")}</Alert>
      {!graph ? <RuntimeSkeleton /> : <>
        <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2.5, overflow: "hidden" }}>
          <Box sx={{ alignItems: "center", display: "flex", gap: 2, justifyContent: "space-between", p: { xs: 2, md: 2.5 } }}>
            <Box><Typography component="h2" variant="h6">{t("Runtime.configuration")}</Typography><Typography color="text.secondary" variant="body2">{t("Runtime.revisionResources", { count: graph.resources.length, revision: graph.revision })}</Typography></Box>
            <Chip color="primary" label={busy ? t("Common.loading") : t("Runtime.readWrite")} size="small" variant="outlined" />
          </Box>
          <Divider />
          <Box sx={{ display: "grid", gap: 2, p: { xs: 2, md: 2.5 } }}>{graph.resources.map((resource) => <ResourceEditor busy={busy} draft={drafts[resourceKey(resource)] ?? {}} key={resourceKey(resource)} onDelete={() => setResourceToDelete(resource)} onSave={() => void saveResource(resource)} onUpdate={(field, value) => updateDraft(resource, field, value)} resource={resource} />)}</Box>
        </Paper>
        <Paper component="section" elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2.5, p: { xs: 2, md: 2.5 } }}>
          <Typography component="h2" variant="h6">{t("Runtime.createResource")}</Typography>
          <Typography color="text.secondary" sx={{ mt: .5 }} variant="body2">{t("Runtime.createDescription")}</Typography>
          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(180px,.45fr) minmax(240px,.55fr)" }, mt: 2.5 }}>
            <TextField label={t("Runtime.kind")} onChange={(event) => setNewKind(event.target.value)} select value={newKind}>{resourceKinds.map((kind) => <MenuItem key={kind} value={kind}>{kind}</MenuItem>)}</TextField>
            <TextField label={t("Runtime.id")} onChange={(event) => setNewResourceId(event.target.value)} placeholder="provider-id" value={newResourceId} />
          </Box>
          <TextField fullWidth label={t("Runtime.initialValue")} minRows={6} multiline onChange={(event) => setNewResourceValue(event.target.value)} spellCheck={false} sx={{ mt: 2 }} value={newResourceValue} />
          <Button disabled={busy || !newResourceId.trim()} onClick={() => void createResource()} sx={{ mt: 2 }} variant="contained">{t("Runtime.createResource")}</Button>
        </Paper>
      </>}
    </Stack>
    <Dialog onClose={() => setResourceToDelete(undefined)} open={Boolean(resourceToDelete)}>
      <DialogTitle>{t("Runtime.deleteResource")}</DialogTitle>
      <DialogContent><DialogContentText>{resourceToDelete ? t("Runtime.deleteDescription", { resource: `${resourceToDelete.kind}/${resourceToDelete.id}` }) : ""}</DialogContentText></DialogContent>
      <DialogActions><Button onClick={() => setResourceToDelete(undefined)}>{t("Common.cancel")}</Button><Button color="error" onClick={() => void deleteResource()} variant="contained">{t("Common.delete")}</Button></DialogActions>
    </Dialog>
  </ConsolePage>;
}

function RuntimeSkeleton() {
  return <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2.5, p: 2.5 }}><Skeleton height={34} width="28%" /><Stack spacing={1.5} sx={{ mt: 3 }}>{[1, 2, 3].map((item) => <Skeleton height={120} key={item} variant="rounded" />)}</Stack></Paper>;
}

function ResourceEditor({ busy, draft, onDelete, onSave, onUpdate, resource }: { busy: boolean; draft: Record<string, unknown>; onDelete(): void; onSave(): void; onUpdate(field: ConfigField, value: unknown): void; resource: ConfigResource }) {
  const t = useTranslations();
  const changed = Object.keys(draft).length;
  return <Paper component="article" elevation={0} sx={{ border: 1, borderColor: changed ? "primary.light" : "divider", borderRadius: 2, p: { xs: 1.75, md: 2.25 } }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}>
      <Box><Typography component="h3" sx={{ fontWeight: 700 }}>{resource.label}</Typography><Stack direction="row" spacing={.75} sx={{ flexWrap: "wrap", mt: .75 }}><Chip label={`${resource.kind}/${resource.id}`} size="small" variant="outlined" />{resource.hotReloadable ? <Chip color="success" label={t("Runtime.hotReload")} size="small" variant="outlined" /> : <Chip color="warning" label={t("Runtime.restartMayBeRequired")} size="small" variant="outlined" />}{resource.runtimeImpact === "critical" ? <Chip color="error" label={t("Runtime.critical")} size="small" variant="outlined" /> : null}</Stack></Box>
      <Button color="error" disabled={busy} onClick={onDelete} size="small" startIcon={<DeleteOutlineRoundedIcon />}>{t("Common.delete")}</Button>
    </Stack>
    <Box sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, mt: 2.5 }}>{resource.schema.fields.map((field) => <ConfigFieldEditor changed={field.path in draft} field={field} key={field.path} onChange={(value) => onUpdate(field, value)} value={field.path in draft ? draft[field.path] : fieldValue(resource, field)} />)}</Box>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { xs: "flex-start", sm: "center" }, mt: 2.5 }}><Button disabled={busy || !changed} onClick={onSave} startIcon={<SaveOutlinedIcon />} variant="outlined">{t("Runtime.validateAndSave")}</Button>{changed ? <Typography color="primary.main" variant="body2">{t("Runtime.pendingChanges", { count: changed })}</Typography> : null}</Stack>
  </Paper>;
}

function ConfigFieldEditor({ changed, field, onChange, value }: { changed: boolean; field: ConfigField; onChange(value: unknown): void; value: unknown }) {
  const t = useTranslations();
  const label = `${field.label}${field.required ? " *" : ""}${field.hotReloadable ? ` · ${t("Runtime.fieldHotReload")}` : ""}`;
  const full = field.control === "textarea" || field.type === "object" || field.type === "array";
  if (field.control === "switch" || field.type === "boolean") return <FormControlLabel control={<Switch checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />} label={label} sx={{ alignItems: "center", border: 1, borderColor: changed ? "primary.light" : "divider", borderRadius: 1.5, m: 0, px: 1.5, py: .75 }} />;
  return <TextField fullWidth label={label} minRows={full ? 5 : undefined} multiline={full} onChange={(event) => onChange(event.target.value)} placeholder={field.secret ? t("Runtime.savedEnterToReplace") : undefined} select={field.control === "select"} spellCheck={false} sx={full ? { gridColumn: "1 / -1" } : undefined} type={field.secret ? "password" : field.type === "number" ? "number" : "text"} value={displayFieldValue(value, field)}>{field.control === "select" ? field.enum?.map((choice) => <MenuItem key={choice} value={choice}>{choice}</MenuItem>) : undefined}</TextField>;
}
