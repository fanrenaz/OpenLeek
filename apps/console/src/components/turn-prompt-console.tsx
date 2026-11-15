"use client";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { type TurnPromptVariableDefinition, type TurnPromptVariableValue } from "@openleek/contracts/turn-prompt";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useMachine } from "@xstate/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { publishedAssetDetails } from "./assets/published-version-details";

type Procedure = {
  query(input: unknown): Promise<unknown>;
  mutate(input: unknown): Promise<unknown>;
};
type Client = {
  console: {
    turnPrompts: Record<
      "list" | "draft" | "version" | "validate" | "preview",
      Procedure
    > &
      Record<"saveDraft" | "publish", Procedure>;
  };
};
type Draft = {
  promptId: string;
  name: string;
  source: string;
  variables: TurnPromptVariableDefinition[];
  revision: number;
  updatedAt?: string;
};
type Version = {
  promptId: string;
  name: string;
  source: string;
  variables: TurnPromptVariableDefinition[];
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
};

const api = (): Client =>
  createTRPCProxyClient<AnyRouter>({
    links: [httpBatchLink({ url: "/api/trpc" })],
  }) as unknown as Client;

function library(value: unknown): { drafts: Draft[]; versions: Version[] } {
  const item =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    drafts: Array.isArray(item.drafts) ? (item.drafts as Draft[]) : [],
    versions: Array.isArray(item.versions) ? (item.versions as Version[]) : [],
  };
}

const blank = (name: string): Draft => ({
  promptId: "",
  name,
  source: "Today is {{utcDate}}.",
  variables: [],
  revision: 0,
});

export function TurnPromptConsole() {
  const t = useTranslations("TurnPrompts");
  const client = useMemo(api, []);
  const [machine, send] = useMachine(assetEditorMachine);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState<Draft>(() => blank(t("untitled")));
  const [status, setStatus] = useState(() => t("loading"));
  const [previewValues, setPreviewValues] = useState<
    Record<string, TurnPromptVariableValue>
  >({});
  const [preview, setPreview] = useState("");

  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try {
      const next = library(await client.console.turnPrompts.list.query({}));
      setDrafts(next.drafts);
      setVersions(next.versions);
      setStatus(t("ready"));
      send({ type: "LOADED" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("loadFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }, [client, send, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function edit(update: (value: Draft) => Draft) {
    setDraft(update);
    setPreview("");
    send({ type: "EDIT" });
  }

  function selectDraft(value: Draft) {
    setDraft(structuredClone(value));
    setPreviewValues(defaultValues(value.variables));
    setPreview("");
    setStatus(t("editing", { name: value.name }));
  }

  function selectVersion(value: Version) {
    setDraft({
      promptId: "",
      name: t("draftFromName", { name: value.name }),
      source: value.source,
      variables: structuredClone(value.variables),
      revision: 0,
    });
    setPreviewValues(defaultValues(value.variables));
    setPreview("");
    setStatus(t("fromVersion", { versionRef: value.versionRef }));
    send({ type: "EDIT" });
  }

  async function saveDraft() {
    try {
      const saved = (await client.console.turnPrompts.saveDraft.mutate({
        ...(draft.promptId
          ? {
              promptId: draft.promptId,
              expectedRevision: draft.revision,
            }
          : {}),
        name: draft.name,
        source: draft.source,
        variables: draft.variables,
      })) as Draft;
      setDraft(saved);
      await refresh();
      setStatus(t("saved", { revision: saved.revision }));
      return saved;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("saveFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
      return undefined;
    }
  }

  async function save() {
    send({ type: "SAVE" });
    const saved = await saveDraft();
    if (saved) send({ type: "SUCCESS" });
  }

  async function validate() {
    send({ type: "VALIDATE" });
    try {
      await client.console.turnPrompts.validate.mutate({
        source: draft.source,
        variables: draft.variables,
      });
      setStatus(t("valid"));
      send({ type: "SUCCESS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("invalid");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }

  async function publish() {
    send({ type: "PUBLISH" });
    const saved = await saveDraft();
    if (!saved) return;
    try {
      const version = (await client.console.turnPrompts.publish.mutate({
        promptId: saved.promptId,
        expectedRevision: saved.revision,
      })) as Version;
      setStatus(t("published", { versionRef: version.versionRef }));
      await refresh();
      send({ type: "SUCCESS" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("publishFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }

  async function renderPreview() {
    try {
      const result = (await client.console.turnPrompts.preview.mutate({
        source: draft.source,
        definitions: draft.variables,
        variables: previewValues,
        utcDate: "2026-07-23",
        roundId: 1,
      })) as { text: string };
      setPreview(result.text);
      setStatus(t("previewReady"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("previewFailed"));
    }
  }

  const draftItems: AssetLibraryItem[] = drafts.map((item) => ({
    id: item.promptId,
    title: item.name,
    detail: `draft r${item.revision} · ${item.promptId}`,
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
  const busy =
    machine.matches("saving") ||
    machine.matches("validating") ||
    machine.matches("publishing");

  return (
    <AssetStudio
      level="global"
      actions={
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.25}
          sx={{ justifyContent: "space-between" }}
        >
          <Button disabled={busy} onClick={() => void validate()} variant="text">
            {t("validate")}
          </Button>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
            <Button disabled={busy} onClick={() => void save()} variant="outlined">
              {t("save")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => send({ type: "REQUEST_PUBLISH" })}
              variant="contained"
            >
              {t("publish")}
            </Button>
          </Stack>
        </Stack>
      }
      createLabel={t("new")}
      description={t("description")}
      drafts={draftItems}
      editor={
        <Stack spacing={3}>
          <Box>
            <Typography component="h2" variant="h5">
              {draft.name || t("untitled")}
            </Typography>
            <Typography color="text.secondary" variant="body2">
              {draft.promptId
                ? t("draftRevision", { revision: draft.revision })
                : t("unsavedDraft")}
            </Typography>
          </Box>

          <TextField
            fullWidth
            label={t("name")}
            onChange={(event) =>
              edit((current) => ({ ...current, name: event.target.value }))
            }
            value={draft.name}
          />
          <TextField
            fullWidth
            helperText={t("sourceHelp")}
            label={t("source")}
            minRows={14}
            multiline
            onChange={(event) =>
              edit((current) => ({ ...current, source: event.target.value }))
            }
            slotProps={{
              htmlInput: {
                spellCheck: false,
                style: {
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                },
              },
            }}
            value={draft.source}
          />

          <Box component="section">
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1.5}
              sx={{
                alignItems: { sm: "flex-start" },
                justifyContent: "space-between",
                mb: 1.5,
              }}
            >
              <Box>
                <Typography component="h3" variant="h6">
                  {t("variables")}
                </Typography>
                <Typography color="text.secondary" variant="body2">
                  {t("variablesHelp")}
                </Typography>
              </Box>
              <Button
                onClick={() =>
                  edit((current) => ({
                    ...current,
                    variables: [
                      ...current.variables,
                      {
                        name: `variable${current.variables.length + 1}`,
                        type: "string",
                        required: false,
                      },
                    ],
                  }))
                }
                startIcon={<AddRoundedIcon />}
                variant="outlined"
              >
                {t("addVariable")}
              </Button>
            </Stack>
            {draft.variables.length ? (
              <Stack spacing={1.5}>
                {draft.variables.map((definition, index) => (
                  <Paper
                    elevation={0}
                    key={index}
                    sx={{ bgcolor: "grey.50", p: { xs: 2, sm: 2.5 } }}
                    variant="outlined"
                  >
                    <Stack spacing={1.5}>
                      <Stack
                        direction={{ xs: "column", md: "row" }}
                        spacing={1.5}
                      >
                        <TextField
                          fullWidth
                          label={t("variableName")}
                          onChange={(event) =>
                            edit((current) => ({
                              ...current,
                              variables: replace(current.variables, index, {
                                ...definition,
                                name: event.target.value,
                              }),
                            }))
                          }
                          value={definition.name}
                        />
                        <TextField
                          fullWidth
                          label={t("type")}
                          onChange={(event) =>
                            edit((current) => ({
                              ...current,
                              variables: replace(current.variables, index, {
                                name: definition.name,
                                type: event.target.value as
                                  | "string"
                                  | "number"
                                  | "boolean",
                                required: definition.required,
                                ...(definition.description === undefined
                                  ? {}
                                  : { description: definition.description }),
                              }),
                            }))
                          }
                          select
                          value={definition.type}
                        >
                          <MenuItem value="string">string</MenuItem>
                          <MenuItem value="number">number</MenuItem>
                          <MenuItem value="boolean">boolean</MenuItem>
                        </TextField>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={definition.required}
                              onChange={(event) =>
                                edit((current) => ({
                                  ...current,
                                  variables: replace(
                                    current.variables,
                                    index,
                                    {
                                      ...definition,
                                      required: event.target.checked,
                                    },
                                  ),
                                }))
                              }
                            />
                          }
                          label={t("required")}
                          sx={{ flexShrink: 0 }}
                        />
                        <Button
                          color="error"
                          onClick={() =>
                            edit((current) => ({
                              ...current,
                              variables: current.variables.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            }))
                          }
                          startIcon={<DeleteOutlineRoundedIcon />}
                        >
                          {t("remove")}
                        </Button>
                      </Stack>
                      <TextField
                        fullWidth
                        label={t("descriptionLabel")}
                        onChange={(event) =>
                          edit((current) => ({
                            ...current,
                            variables: replace(current.variables, index, {
                              ...definition,
                              ...(event.target.value
                                ? { description: event.target.value }
                                : { description: undefined }),
                            }),
                          }))
                        }
                        value={definition.description ?? ""}
                      />
                      <ValueField
                        label={t("defaultValue")}
                        onChange={(defaultValue) =>
                          edit((current) => ({
                            ...current,
                            variables: replace(current.variables, index, {
                              ...definition,
                              defaultValue,
                            }),
                          }))
                        }
                        type={definition.type}
                        value={definition.defaultValue}
                      />
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <Paper
                elevation={0}
                sx={{
                  borderStyle: "dashed",
                  color: "text.secondary",
                  px: 2.5,
                  py: 4,
                  textAlign: "center",
                }}
                variant="outlined"
              >
                <Typography variant="body2">{t("noVariables")}</Typography>
              </Paper>
            )}
          </Box>

          <Box component="section">
            <Typography component="h3" variant="h6">
              {t("preview")}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }} variant="body2">
              {t("previewDescription")}
            </Typography>
            <Paper
              elevation={0}
              sx={{ bgcolor: "grey.50", mt: 1.5, p: { xs: 2, sm: 2.5 } }}
              variant="outlined"
            >
              <Stack spacing={2}>
                <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1 }}>
                  <Chip label="utcDate = 2026-07-23" size="small" />
                  <Chip label="roundId = 1" size="small" />
                </Stack>
                {draft.variables.map((definition) => (
                  <ValueField
                    key={definition.name}
                    label={definition.name}
                    onChange={(value) =>
                      setPreviewValues((current) => ({
                        ...current,
                        [definition.name]: value,
                      }))
                    }
                    type={definition.type}
                    value={
                      previewValues[definition.name] ??
                      definition.defaultValue
                    }
                  />
                ))}
                <Box>
                  <Button
                    onClick={() => void renderPreview()}
                    variant="outlined"
                  >
                    {t("render")}
                  </Button>
                </Box>
                {preview ? (
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: "background.paper",
                      border: 1,
                      borderColor: "divider",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, monospace",
                      fontSize: ".82rem",
                      lineHeight: 1.65,
                      m: 0,
                      overflow: "auto",
                      p: 2,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {preview}
                  </Box>
                ) : null}
              </Stack>
            </Paper>
          </Box>
        </Stack>
      }
      onCancelPublish={() => send({ type: "DISMISS" })}
      onConfirmPublish={() => void publish()}
      onCreate={() => {
        setDraft(blank(t("untitled")));
        setPreviewValues({});
        setPreview("");
        setStatus(t("newDraft"));
        send({ type: "EDIT" });
      }}
      onRefresh={() => void refresh()}
      onSelectDraft={(item) => {
        const found = drafts.find((value) => value.promptId === item.id);
        if (found) selectDraft(found);
      }}
      onCreateFromVersion={(item) => {
        const found = versions.find((value) => value.versionRef === item.id);
        if (found) selectVersion(found);
      }}
      renderVersionDetails={publishedAssetDetails("turn-prompt")}
      phase={machine.value as string}
      publishDescription={t("publishDescription")}
      publishOpen={machine.matches("confirmingPublish")}
      publishTitle={t("publishTitle")}
      selectedDraftId={draft.promptId}
      status={status}
      title={t("title")}
      versions={versionItems}
    />
  );
}

function replace<T>(values: T[], index: number, value: T): T[] {
  return values.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function defaultValues(
  definitions: TurnPromptVariableDefinition[],
): Record<string, TurnPromptVariableValue> {
  return Object.fromEntries(
    definitions.flatMap((definition) =>
      definition.defaultValue === undefined
        ? []
        : [[definition.name, definition.defaultValue]],
    ),
  );
}

function ValueField({
  label,
  type,
  value,
  onChange,
}: {
  label: string;
  type: "string" | "number" | "boolean";
  value: TurnPromptVariableValue | undefined;
  onChange(value: TurnPromptVariableValue): void;
}) {
  if (type === "boolean") {
    return (
      <TextField
        fullWidth
        label={label}
        onChange={(event) => onChange(event.target.value === "true")}
        select
        value={String(value ?? false)}
      >
        <MenuItem value="true">true</MenuItem>
        <MenuItem value="false">false</MenuItem>
      </TextField>
    );
  }
  return (
    <TextField
      fullWidth
      label={label}
      multiline={type === "string"}
      onChange={(event) =>
        onChange(
          type === "number" ? Number(event.target.value) : event.target.value,
        )
      }
      type={type === "number" ? "number" : "text"}
      value={value ?? ""}
    />
  );
}
