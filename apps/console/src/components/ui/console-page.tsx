import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function ConsolePage({ children, maxWidth = 1440 }: { children: ReactNode; maxWidth?: number }) {
  return <Box component="main" sx={{ margin: "0 auto", maxWidth, px: { xs: 2, sm: 3, lg: 5 }, py: { xs: 3, lg: 5 }, width: "100%" }}>{children}</Box>;
}

export function ConsolePageHeader({ action, description, title }: { action?: ReactNode; description: ReactNode; title: ReactNode }) {
  return <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ justifyContent: "space-between", mb: 4 }}>
    <Box sx={{ maxWidth: 760 }}>
      <Typography color="primary.main" sx={{ fontWeight: 750, fontSize: ".72rem", letterSpacing: ".08em", mb: 1, textTransform: "uppercase" }}>OpenLeek Console</Typography>
      <Typography component="h1" variant="h1">{title}</Typography>
      <Typography color="text.secondary" sx={{ lineHeight: 1.7, mt: 1.25 }}>{description}</Typography>
    </Box>
    {action ? <Box sx={{ alignSelf: { md: "flex-end" }, flexShrink: 0 }}>{action}</Box> : null}
  </Stack>;
}
