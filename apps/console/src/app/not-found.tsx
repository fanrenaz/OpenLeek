import { Box, Button, Paper, Typography } from "@mui/material";
import Link from "next/link";

export default function NotFound() {
  return <Box component="main" sx={{ alignItems: "center", display: "grid", minHeight: "70dvh", p: 3 }}>
    <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 3, margin: "auto", maxWidth: 520, p: { xs: 3, sm: 4 }, textAlign: "center" }}>
      <Typography color="primary.main" sx={{ fontWeight: 750 }} variant="overline">OpenLeek Console</Typography>
      <Typography component="h1" sx={{ mt: 1 }} variant="h3">This page is unavailable</Typography>
      <Typography color="text.secondary" sx={{ mt: 1.25 }}>Return to experiment runs to continue your research workflow.</Typography>
      <Button component={Link} href="/" sx={{ mt: 3 }} variant="contained">Go to runs</Button>
    </Paper>
  </Box>;
}
