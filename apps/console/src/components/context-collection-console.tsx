"use client";

import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { localized, useConsoleContexts } from "./ui/settings-dialog";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { contexts: { assetRead: Procedure; assetCommand: Procedure } } };
const api = () => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client;

const renderers = {
  "social-network": dynamic(() => import("./social-network-console").then((module) => module.SocialNetworkConsole), { ssr: false }),
  "feed-algorithm": dynamic(() => import("./feed-algorithm-console").then((module) => module.FeedAlgorithmConsole), { ssr: false }),
  "financial-preset": dynamic(() => import("./financial-preset-console").then((module) => module.FinancialPresetConsole), { ssr: false }),
  "market-maker": dynamic(() => import("./market-maker-console").then((module) => module.MarketMakerConsole), { ssr: false }),
} as const;

export function ContextCollectionConsole({ contextId, collectionId }: { contextId: string; collectionId: string }) {
  const locale = useLocale();
  const t = useTranslations("WorldFactory");
  const { contexts } = useConsoleContexts();
  const context = contexts.find((item) => item.contextId === contextId);
  const collection = context?.worldEnvironment.collections.find((item) => item.id === collectionId);
  const renderer = collection?.uiSchema?.renderer;
  const Component = typeof renderer === "string" && renderer in renderers ? renderers[renderer as keyof typeof renderers] : undefined;
  if (Component) return <Component />;
  if (context && collection) return <GenericContextCollection collection={collection} contextId={contextId} />;
  return <Box sx={{ maxWidth: 900, mx: "auto", p: { xs: 2, md: 4 } }}>
    <Typography component="h1" variant="h3">{collection ? localized(collection.label, locale) : collectionId}</Typography>
    <Alert severity={collection ? "info" : "error"} sx={{ mt: 3 }}>
      {collection ? t("genericCollection") : t("collectionMissing")}
    </Alert>
  </Box>;
}

function GenericContextCollection({ collection, contextId }: {
  collection: {
    id: string;
    label: { default: string; translations?: Record<string, string> };
    description?: { default: string; translations?: Record<string, string> };
    definitionSchema: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
    actions: Array<"list" | "draft" | "save" | "validate" | "publish" | "preview">;
  };
  contextId: string;
}) {
  const client = useMemo(api, []);
  const locale = useLocale();
  const t = useTranslations("WorldFactory");
  const [library, setLibrary] = useState<{ drafts: unknown[]; versions: unknown[] }>({ drafts: [], versions: [] });
  const [value, setValue] = useState("{}");
  const [status, setStatus] = useState(t("loadingCollection"));
  async function refresh() {
    try {
      const response = await client.console.contexts.assetRead.query({ contextId, collectionId: collection.id, operation: "list" });
      const record = response && typeof response === "object" ? response as Record<string, unknown> : {};
      setLibrary({
        drafts: Array.isArray(record.drafts) ? record.drafts : [],
        versions: Array.isArray(record.versions) ? record.versions : [],
      });
      setStatus(t("collectionReady"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("collectionFailed"));
    }
  }
  useEffect(() => { void refresh(); }, [contextId, collection.id]);

  async function command(operation: "save" | "validate" | "publish" | "preview") {
    try {
      const input: unknown = JSON.parse(value);
      const result = await client.console.contexts.assetCommand.mutate({ contextId, collectionId: collection.id, operation, input });
      setValue(JSON.stringify(result, null, 2));
      setStatus(t("operationComplete"));
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("operationFailed"));
    }
  }

  return <Box sx={{ maxWidth: 1100, mx: "auto", p: { xs: 2, md: 4 } }}>
    <Typography component="h1" variant="h3">{localized(collection.label, locale)}</Typography>
    {collection.description ? <Typography color="text.secondary" sx={{ mt: 1 }}>{localized(collection.description, locale)}</Typography> : null}
    <Alert severity="info" sx={{ mt: 2 }}>{status}</Alert>
    <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "1fr", md: "minmax(240px,.38fr) minmax(0,.62fr)" }, mt: 3 }}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6">{t("published")}</Typography>
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {library.versions.map((item, index) => <Button key={index} onClick={() => setValue(JSON.stringify(item, null, 2))} sx={{ justifyContent: "flex-start" }} variant="text">{itemLabel(item, index)}</Button>)}
          {!library.versions.length ? <Typography color="text.secondary" variant="body2">{t("noPublished")}</Typography> : null}
        </Stack>
        <Typography sx={{ mt: 3 }} variant="h6">{t("drafts")}</Typography>
        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {library.drafts.map((item, index) => <Button key={index} onClick={() => setValue(JSON.stringify(item, null, 2))} sx={{ justifyContent: "flex-start" }} variant="text">{itemLabel(item, index)}</Button>)}
          {!library.drafts.length ? <Typography color="text.secondary" variant="body2">{t("noDrafts")}</Typography> : null}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6">{t("metadataEditor")}</Typography>
        <Typography color="text.secondary" variant="body2">{t("metadataEditorHelp")}</Typography>
        <TextField fullWidth minRows={18} multiline onChange={(event) => setValue(event.target.value)} spellCheck={false} sx={{ mt: 2 }} value={value} />
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", mt: 2 }}>
          <Button onClick={() => setValue("{}")} variant="outlined">{t("newDraft")}</Button>
          {collection.actions.filter((action): action is "save" | "validate" | "publish" | "preview" => action !== "list" && action !== "draft").map((action) =>
            <Button key={action} onClick={() => void command(action)} variant={action === "publish" ? "contained" : "outlined"}>{t(`actions.${action}`)}</Button>
          )}
        </Stack>
      </Paper>
    </Box>
  </Box>;
}

function itemLabel(value: unknown, index: number): string {
  if (!value || typeof value !== "object") return `#${index + 1}`;
  const record = value as Record<string, unknown>;
  return [record.name, record.title, record.id, record.versionRef].find((item): item is string => typeof item === "string") ?? `#${index + 1}`;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
