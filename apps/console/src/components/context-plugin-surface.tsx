"use client";
import { Alert, Skeleton } from "@mui/material";
import { createElement, useEffect, useState } from "react";

type Surface = "configuration" | "assets" | "observer" | "facts";
type Metadata = { uiModule: { sha256: string; elements: Partial<Record<Surface, string>> } };

export function ContextPluginSurface({ contextId, surface, runId, revisionRef }: { contextId: string; surface: Surface; runId?: string; revisionRef?: string }) {
  const [tag, setTag] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch(`/api/context-ui/${encodeURIComponent(contextId)}?meta=1`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
      const metadata = await response.json() as Metadata;
      const element = metadata.uiModule.elements[surface];
      if (!element) throw new Error(`Context does not publish a ${surface} element`);
      await import(/* webpackIgnore: true */ `/api/context-ui/${encodeURIComponent(contextId)}?sha=${metadata.uiModule.sha256}`);
      if (active) setTag(element);
    })().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [contextId, surface]);
  if (error) return <Alert severity="warning">{error}</Alert>;
  if (!tag) return <Skeleton height={72} variant="rounded" />;
  return createElement(tag, { "run-id": runId ?? "", "revision-ref": revisionRef ?? "" });
}
