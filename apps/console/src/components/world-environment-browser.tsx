"use client";

import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { localized, useConsoleContexts } from "./ui/settings-dialog";

export function WorldEnvironmentBrowser() {
  const locale = useLocale();
  const t = useTranslations("WorldFactory");
  const { visibleContexts } = useConsoleContexts();

  return <Box sx={{ maxWidth: 1180, mx: "auto", p: { xs: 2, md: 4 } }}>
    <Typography component="h1" variant="h3">{t("environmentTitle")}</Typography>
    <Typography color="text.secondary" sx={{ mt: 1 }}>{t("environmentDescription")}</Typography>
    {!visibleContexts.length ? <Alert severity="info" sx={{ mt: 3 }}>{t("noContexts")}</Alert> :
      <Stack spacing={2.5} sx={{ mt: 4 }}>
        {visibleContexts.map((context) => <Paper key={context.contextId} variant="outlined" sx={{ p: 3 }}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography component="h2" variant="h5">{localized(context.label, locale)}</Typography>
                {!context.available ? <Chip color="warning" label={t("unavailable")} size="small" /> : null}
              </Stack>
              <Typography color="text.secondary" sx={{ mt: .75 }}>{localized(context.description, locale)}</Typography>
            </Box>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ flexWrap: "wrap", mt: 2.5 }}>
            {context.worldEnvironment.collections.map((collection) =>
              <Button
                component={Link}
                disabled={!context.available}
                endIcon={<ArrowForwardRoundedIcon />}
                href={`/world-factory/environments/${encodeURIComponent(context.contextId)}/${encodeURIComponent(collection.id)}`}
                key={collection.id}
                variant="outlined"
              >
                {localized(collection.label, locale)}
              </Button>
            )}
            {!context.worldEnvironment.collections.length ? <Typography color="text.secondary" variant="body2">{t("noCollections")}</Typography> : null}
          </Stack>
        </Paper>)}
      </Stack>}
  </Box>;
}
