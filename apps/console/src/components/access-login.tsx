"use client";

import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

export function AccessLogin() {
  const t = useTranslations();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/access/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) {
        setError(response.status === 401 ? t("Login.incorrectPassword") : t("Login.unavailable"));
        return;
      }
      window.location.assign("/");
    } catch {
      setError(t("Login.unavailable"));
    } finally {
      setSubmitting(false);
    }
  }

  return <Box component="main" sx={{ alignItems: "center", background: "radial-gradient(circle at 100% 0%, rgba(23,107,77,.13), transparent 34%), #f5f7f6", display: "grid", minHeight: "100dvh", p: 2 }}>
    <Paper component="form" elevation={0} onSubmit={submit} sx={{ border: 1, borderColor: "divider", borderRadius: 3, margin: "auto", maxWidth: 440, p: { xs: 3, sm: 4 }, width: "100%" }}>
      <Stack spacing={2.25}>
        <Box sx={{ alignItems: "center", color: "primary.main", display: "flex", gap: 1 }}><Box sx={{ alignItems: "center", bgcolor: "primary.light", borderRadius: 1.5, display: "flex", height: 34, justifyContent: "center", width: 34 }}><LockOutlinedIcon fontSize="small" /></Box><Typography sx={{ fontWeight: 750 }}>OpenLeek</Typography></Box>
        <Box><Typography component="h1" variant="h4">{t("Login.title")}</Typography><Typography color="text.secondary" sx={{ mt: 1 }}>{t("Login.description")}</Typography></Box>
        <TextField autoComplete="current-password" autoFocus label={t("Login.password")} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
        {error ? <Alert severity="error">{error}</Alert> : null}
        <Button disabled={submitting} size="large" type="submit" variant="contained">{submitting ? t("Common.loading") : t("Login.continue")}</Button>
      </Stack>
    </Paper>
  </Box>;
}
