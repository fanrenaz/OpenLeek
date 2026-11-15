"use client";

import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import type { ReactNode } from "react";

const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0b0e11", paper: "#11161c" },
    primary: { main: "#f0b90b" },
    success: { main: "#0ecb81" },
    error: { main: "#f6465d" },
    text: { primary: "#eaecef", secondary: "#848e9c" },
    divider: "rgba(132,142,156,.18)",
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Inter", "Segoe UI", sans-serif',
    button: { textTransform: "none", fontWeight: 650 },
  },
  shape: { borderRadius: 6 },
});

export function Providers({ children }: { children: ReactNode }) {
  return <AppRouterCacheProvider><ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider></AppRouterCacheProvider>;
}
