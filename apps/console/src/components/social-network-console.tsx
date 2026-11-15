"use client";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMachine } from "@xstate/react";
import { useTranslations } from "next-intl";
import { AssetStudio, type AssetLibraryItem } from "./assets/asset-studio";
import { assetEditorMachine } from "./assets/asset-editor-machine";
import { publishedAssetDetails } from "./assets/published-version-details";
import { PythonCodeEditor } from "./python-code-editor";
type Procedure = {
  query(input: unknown): Promise<unknown>;
  mutate(input: unknown): Promise<unknown>;
};
type Client = {
  console: {
    socialNetworks: Record<
      "list" | "saveDraft" | "validate" | "publish",
      Procedure
    >;
  };
};
type Draft = {
  networkId: string;
  name: string;
  source: string;
  defaultConfig: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  dependencies: string[];
  limits: { maxRuntimeMs: number; maxMemoryMb: number };
  revision: number;
  updatedAt?: string;
};
type Version = Omit<Draft, "revision" | "updatedAt"> & {
  versionRef: string;
  artifactDigest: string;
  publishedAt: string;
  draftRevision: number;
};
type Validation = {
  valid: boolean;
  errors?: string[];
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
};
const source = `class NetworkGenerator:\n    CONFIG_SCHEMA = {"type": "object"}\n    DEFAULT_CONFIG = {}\n\n    def __init__(self, config, context):\n        self.config = config\n        self.context = context\n\n    def generate(self):\n        return {"relationships": []}\n`;
const blank = (name = "Untitled Social Network"): Draft => ({
  networkId: "",
  name,
  source,
  defaultConfig: {},
  configSchema: {},
  dependencies: [],
  limits: { maxRuntimeMs: 60_000, maxMemoryMb: 1_024 },
  revision: 0,
});
const api = () =>
  createTRPCProxyClient<AnyRouter>({
    links: [httpBatchLink({ url: "/api/trpc" })],
  }) as unknown as Client;
const lib = (value: unknown) => {
  const r =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    drafts: Array.isArray(r.drafts) ? (r.drafts as Draft[]) : [],
    versions: Array.isArray(r.versions) ? (r.versions as Version[]) : [],
  };
};
const parseObject = (
  value: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
};
export function SocialNetworkConsole() {
  const t = useTranslations("Assets");
  const client = useMemo(api, []);
  const [machine, send] = useMachine(assetEditorMachine);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [draft, setDraft] = useState(() => blank(t("socialNetworkUntitled")));
  const [config, setConfig] = useState("{}");
  const [status, setStatus] = useState(() => t("socialNetworkLoading"));
  const [validation, setValidation] = useState<Validation>();
  const refresh = useCallback(async () => {
    send({ type: "LOAD" });
    try {
      const next = lib(await client.console.socialNetworks.list.query({}));
      setDrafts(next.drafts);
      setVersions(next.versions);
      setStatus(t("socialNetworkReady"));
      send({ type: "LOADED" });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("socialNetworkLoadFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  }, [client, send, t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const save = async () => {
    try {
      const saved = (await client.console.socialNetworks.saveDraft.mutate({
        ...(draft.networkId
          ? { networkId: draft.networkId, expectedRevision: draft.revision }
          : {}),
        name: draft.name,
        source: draft.source,
        defaultConfig: JSON.parse(config),
        configSchema: draft.configSchema,
        dependencies: draft.dependencies,
        limits: draft.limits,
      })) as Draft;
      setDraft(saved);
      setConfig(JSON.stringify(saved.defaultConfig, null, 2));
      setStatus(t("socialNetworkSaved", { revision: saved.revision }));
      await refresh();
      return saved;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("socialNetworkSaveFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  };
  const validate = async () => {
    const saved = await save();
    if (!saved) return;
    send({ type: "VALIDATE" });
    try {
      const result = (await client.console.socialNetworks.validate.mutate({
        networkId: saved.networkId,
        source: saved.source,
        dependencies: saved.dependencies,
        limits: saved.limits,
      })) as Validation;
      setValidation(result);
      setStatus(
        result.valid
          ? t("socialNetworkValidated")
          : result.errors?.join(" ") || t("validationFailed"),
      );
      send({ type: "SUCCESS" });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("socialNetworkValidateFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  };
  const publish = async () => {
    send({ type: "PUBLISH" });
    const saved = await save();
    if (!saved) return;
    try {
      const version = (await client.console.socialNetworks.publish.mutate({
        networkId: saved.networkId,
        expectedRevision: saved.revision,
      })) as Version;
      setStatus(t("publishedRef", { versionRef: version.versionRef }));
      await refresh();
      send({ type: "SUCCESS" });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("socialNetworkPublishFailed");
      setStatus(message);
      send({ type: "FAIL", error: message });
    }
  };
  const draftItems: AssetLibraryItem[] =
    drafts.map((item) => ({
      id: item.networkId,
      title: item.name,
      detail: t("draftRevision", { revision: item.revision }),
      timestamp: item.updatedAt,
      data: item,
    }));
  const versionItems: AssetLibraryItem<Version>[] =
    versions.map((item) => ({
      id: item.versionRef,
      title: item.name,
      detail: `${item.versionRef} · ${item.artifactDigest}`,
      timestamp: item.publishedAt,
      data: item,
    }));
  return (
    <AssetStudio
      level="global"
      title={t("socialNetworkTitle")}
      description={t("socialNetworkDescription")}
      status={status}
      phase={machine.value as string}
      drafts={draftItems}
      versions={versionItems}
      selectedDraftId={draft.networkId}
      onRefresh={() => void refresh()}
      onCreate={() => {
        setDraft(blank(t("socialNetworkUntitled")));
        setConfig("{}");
        send({ type: "EDIT" });
      }}
      createLabel={t("newSocialNetwork")}
      onSelectDraft={(item) => {
        const found = drafts.find((value) => value.networkId === item.id);
        if (found) {
          setDraft(found);
          setConfig(JSON.stringify(found.defaultConfig, null, 2));
        }
      }}
      onCreateFromVersion={(item) => {
        const found = versions.find((value) => value.versionRef === item.id);
        if (found) {
          setDraft({
            networkId: "",
            revision: 0,
            name: t("draftFromName", { name: found.name }),
            source: found.source,
            defaultConfig: structuredClone(found.defaultConfig),
            configSchema: structuredClone(found.configSchema),
            dependencies: [...found.dependencies],
            limits: { ...found.limits },
          });
          setConfig(JSON.stringify(found.defaultConfig, null, 2));
          send({ type: "EDIT" });
        }
      }}
      renderVersionDetails={publishedAssetDetails("network")}
      editor={
        <Stack spacing={2.5}>
          <Typography variant="h5">{draft.name}</Typography>
          <TextField
            label={t("name")}
            value={draft.name}
            onChange={(event) => {
              setDraft((value) => ({ ...value, name: event.target.value }));
              send({ type: "EDIT" });
            }}
          />
          <PythonCodeEditor
            value={draft.source}
            onChange={(value) => {
              setDraft((current) => ({ ...current, source: value }));
              send({ type: "EDIT" });
            }}
          />
          <TextField
            label={t("defaultConfig")}
            multiline
            minRows={6}
            value={config}
            onChange={(event) => {
              setConfig(event.target.value);
              send({ type: "EDIT" });
            }}
          />
          {validation && (
            <Alert severity={validation.valid ? "success" : "error"}>
              {validation.valid
                ? t("validationPassed")
                : validation.errors?.join(" ")}
            </Alert>
          )}
        </Stack>
      }
      actions={
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button variant="outlined" onClick={() => void save()}>
            {t("saveDraft")}
          </Button>
          <Button variant="outlined" onClick={() => void validate()}>
            {t("validatePython")}
          </Button>
          <Button
            variant="contained"
            onClick={() => send({ type: "REQUEST_PUBLISH" })}
          >
            {t("publishVersion")}
          </Button>
        </Stack>
      }
      publishOpen={machine.matches("confirmingPublish")}
      onCancelPublish={() => send({ type: "DISMISS" })}
      onConfirmPublish={() => void publish()}
      publishTitle={t("socialNetworkPublishTitle")}
      publishDescription={t("socialNetworkPublishDescription")}
    />
  );
}
