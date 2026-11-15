"use client";

import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import type { ReactNode } from "react";

const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#000000", paper: "#080808" },
    primary: { main: "#1d9bf0" },
    text: { primary: "#f2f2f2", secondary: "#71767b" },
    divider: "#2f3336",
  },
  typography: {
    fontFamily: '"Inter", "Segoe UI", "PingFang SC", sans-serif',
    button: { textTransform: "none", fontWeight: 700 },
  },
  shape: { borderRadius: 14 },
});

export function Providers({ children }: { children: ReactNode }) {
  return <AppRouterCacheProvider><ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider></AppRouterCacheProvider>;
}
