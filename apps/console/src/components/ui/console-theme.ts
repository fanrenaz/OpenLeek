import { createTheme } from "@mui/material/styles";
import { Noto_Sans } from "next/font/google";

export const consoleSans = Noto_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-console-sans",
});

export const consoleTheme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#176b4d", dark: "#0f513a", light: "#e3f3ea", contrastText: "#ffffff" },
    background: { default: "#f5f7f6", paper: "#ffffff" },
    text: { primary: "#18211d", secondary: "#627069" },
    divider: "#d8e0db",
    error: { main: "#b42318" },
    warning: { main: "#b54708" },
    info: { main: "#175cd3" },
    success: { main: "#176b4d" },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: "var(--font-console-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    h1: { fontSize: "clamp(2rem, 3vw, 3.05rem)", fontWeight: 650, letterSpacing: "-0.04em", lineHeight: 1.08 },
    h2: { fontWeight: 650, letterSpacing: "-0.02em" },
    overline: { fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.08em", lineHeight: 1.6 },
    button: { textTransform: "none", fontWeight: 650 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { backgroundColor: "#f5f7f6" },
        body: { margin: 0, backgroundColor: "#f5f7f6" },
        "*": { boxSizing: "border-box" },
        "*:focus-visible": { outline: "3px solid rgba(23, 107, 77, .38)", outlineOffset: 2 },
        ".skip-link": { left: 16, position: "fixed", top: -80, zIndex: 1500 },
        ".skip-link:focus": { top: 16 },
      },
    },
    MuiButton: { styleOverrides: { root: { borderRadius: 8, boxShadow: "none", minHeight: 38 }, contained: { boxShadow: "0 8px 20px rgba(20, 91, 63, .16)" } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTableCell: { styleOverrides: { root: { borderColor: "#e5ebe7" }, head: { color: "#627069", fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" } } },
  },
});
