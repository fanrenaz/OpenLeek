"use client";

import { Alert, Box, Button, Chip, CircularProgress, Link, Paper, Stack, Typography } from "@mui/material";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { useCallback, useEffect, useMemo, useState } from "react";

type Procedure = { query(input: unknown): Promise<unknown>; mutate(input: unknown): Promise<unknown> };
type Client = { console: { executionProviders: Procedure; chatGptAuth: Record<"startDeviceAuthorization" | "cancelDeviceAuthorization" | "logout", Procedure> } };
const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function ExecutionProvidersConsole() {
  const client = useMemo(() => createTRPCProxyClient<AnyRouter>({ links: [httpBatchLink({ url: "/api/trpc" })] }) as unknown as Client, []);
  const [value, setValue] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { try { setValue(record(await client.console.executionProviders.query({}))); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, [client]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [refresh]);
  const providers = Array.isArray(value?.providers) ? value.providers.map(record) : [];
  const openai = providers.find((provider) => provider.provider === "openai");
  const account = record(openai?.account);
  const pending = record(openai?.pending);
  const action = async (name: "startDeviceAuthorization" | "cancelDeviceAuthorization" | "logout") => { setBusy(true); try { await client.console.chatGptAuth[name].mutate({}); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <Box component="main" sx={{ maxWidth: 960, mx: "auto", p: { xs: 2, md: 4 } }}><Stack spacing={3}>
    <Box><Typography variant="overline" color="primary">AGENT FACTORY</Typography><Typography variant="h3">Execution Providers</Typography><Typography color="text.secondary">Manage the Runtime-owned global ChatGPT account and inspect models available for new Runs.</Typography></Box>
    {error ? <Alert severity="error">{error}</Alert> : null}
    {!value ? <CircularProgress /> : providers.map((provider) => <Paper key={String(provider.provider)} variant="outlined" sx={{ p: 3 }}><Stack spacing={2}>
      <Stack direction="row" sx={{ justifyContent: "space-between" }}><Typography variant="h5">{provider.provider === "openai" ? "OpenAI / ChatGPT" : "DeepSeek"}</Typography><Chip color={provider.available ? "success" : "default"} label={provider.available ? "Available" : "Authorization required"} /></Stack>
      {provider.provider === "openai" ? <><Typography color="text.secondary">{account.email ? `${String(account.email)} · ${String(account.planType ?? "ChatGPT")}` : "No ChatGPT account is currently authorized."}</Typography>
        {pending.verificationUrl && pending.userCode ? <Alert severity="info">Open <Link href={String(pending.verificationUrl)} target="_blank" rel="noreferrer">{String(pending.verificationUrl)}</Link> and enter code <strong>{String(pending.userCode)}</strong>.</Alert> : null}
        <Stack direction="row" spacing={1}><Button variant="contained" disabled={busy || Boolean(pending.loginId)} onClick={() => void action("startDeviceAuthorization")}>Authorize with device code</Button>{pending.loginId ? <Button disabled={busy} onClick={() => void action("cancelDeviceAuthorization")}>Cancel authorization</Button> : null}{account.email ? <Button color="error" disabled={busy} onClick={() => void action("logout")}>Log out</Button> : null}</Stack>
      </> : null}
      <Box><Typography variant="subtitle2">Models</Typography><Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", mt: 1 }}>{(Array.isArray(provider.models) ? provider.models : []).map((raw) => { const model = record(raw); return <Chip key={String(model.id)} label={`${String(model.displayName ?? model.id)} · ${(Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).join("/")}`} />; })}</Stack></Box>
    </Stack></Paper>)}
  </Stack></Box>;
}
