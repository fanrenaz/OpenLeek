"use client";

import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import {
  Alert,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LocaleSwitcher } from "./locale-switcher";

type LocalizedText = { default: string; translations?: Record<string, string> };
export type ConsoleContext = {
  contextId: string;
  available: boolean;
  label: LocalizedText;
  description: LocalizedText;
  agentEnvironment: {
    accountPolicySchema: Record<string, unknown>;
    capabilities: Array<{ id: string; kind: "tool" | "resource"; label: LocalizedText }>;
  };
  worldEnvironment: { collections: Array<{
    id: string;
    label: LocalizedText;
    description?: LocalizedText;
    definitionSchema: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
    actions: Array<"list" | "draft" | "save" | "validate" | "publish" | "preview">;
  }> };
};
type CatalogClient = { console: { contexts: { catalog: { query(input: {}): Promise<unknown> } } } };

export const CONTEXT_VISIBILITY_STORAGE_KEY = "openleek_console_hidden_contexts_v1";
export const CONTEXT_VISIBILITY_EVENT = "openleek-context-visibility";

function api(): CatalogClient {
  return createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as CatalogClient;
}

function parseCatalog(value: unknown): ConsoleContext[] {
  if (!value || typeof value !== "object") return [];
  const contexts = (value as { contexts?: unknown }).contexts;
  return Array.isArray(contexts) ? contexts.filter((item): item is ConsoleContext =>
    Boolean(item && typeof item === "object" && typeof (item as ConsoleContext).contextId === "string")
  ) : [];
}

export function hiddenContextIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CONTEXT_VISIBILITY_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function localized(value: LocalizedText, locale: string): string {
  return value.translations?.[locale] ?? value.default;
}

export function SettingsDialog({ contexts, onContextsChanged }: { contexts: ConsoleContext[]; onContextsChanged(): void }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const locale = useLocale();
  const t = useTranslations("Settings");

  useEffect(() => setHidden(hiddenContextIds()), [open]);

  function toggle(contextId: string) {
    const next = new Set(hidden);
    if (next.has(contextId)) next.delete(contextId); else next.add(contextId);
    setHidden(next);
    window.localStorage.setItem(CONTEXT_VISIBILITY_STORAGE_KEY, JSON.stringify([...next].sort()));
    window.dispatchEvent(new Event(CONTEXT_VISIBILITY_EVENT));
    onContextsChanged();
  }

  return <>
    <Tooltip title={t("title")}>
      <IconButton aria-label={t("open")} onClick={() => setOpen(true)}><SettingsOutlinedIcon /></IconButton>
    </Tooltip>
    <Dialog fullWidth maxWidth="sm" onClose={() => setOpen(false)} open={open}>
      <DialogTitle>{t("title")}</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ pt: 1 }}>
          <Box>
            <Typography sx={{ fontWeight: 700, mb: 1 }} variant="subtitle2">{t("language")}</Typography>
            <LocaleSwitcher />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 700 }} variant="subtitle2">{t("contexts")}</Typography>
            <Typography color="text.secondary" variant="body2">{t("contextsHelp")}</Typography>
            {!contexts.length ? <Alert severity="info" sx={{ mt: 1.5 }}>{t("noContexts")}</Alert> : <List disablePadding sx={{ mt: 1 }}>
              {contexts.map((context) => <ListItem disableGutters key={context.contextId} secondaryAction={
                <Switch
                  checked={!hidden.has(context.contextId)}
                  disabled={!context.available}
                  slotProps={{ input: { "aria-label": localized(context.label, locale) } }}
                  onChange={() => toggle(context.contextId)}
                />
              }>
                <ListItemText
                  primary={localized(context.label, locale)}
                  secondary={context.available ? localized(context.description, locale) : t("unavailable")}
                />
              </ListItem>)}
            </List>}
          </Box>
        </Stack>
      </DialogContent>
    </Dialog>
  </>;
}

export function useConsoleContexts() {
  const client = useMemo(api, []);
  const [contexts, setContexts] = useState<ConsoleContext[]>([]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    void client.console.contexts.catalog.query({}).then((value) => {
      if (active) setContexts(parseCatalog(value));
    }).catch(() => {
      if (active) setContexts([]);
    });
    return () => { active = false; };
  }, [client]);

  const hidden = useMemo(() => {
    revision;
    return hiddenContextIds();
  }, [revision]);
  return { contexts, visibleContexts: contexts.filter((context) => !hidden.has(context.contextId)), refresh };
}
