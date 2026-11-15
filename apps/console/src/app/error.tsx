"use client";

import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <Box component="main" sx={{ alignItems: "center", display: "grid", minHeight: "70dvh", p: 3 }}>
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 3, margin: "auto", maxWidth: 560, p: { xs: 3, sm: 4 }, width: "100%" }}>
      <Stack spacing={2}><Box><Typography color="primary.main" sx={{ fontWeight: 750 }} variant="overline">OpenLeek Console</Typography><Typography component="h1" variant="h4">We could not load this workspace</Typography></Box><Alert severity="error">The request did not complete. Retry it, or return to the run index.</Alert><Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}><Button onClick={reset} variant="contained">Retry</Button><Button href="/" variant="outlined">Go to runs</Button></Stack></Stack>
    </Paper>
  </Box>;
}
