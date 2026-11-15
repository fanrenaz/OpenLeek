import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // A browser command waits for the Context saga and a real provider turn.
  // Give a two-round real-provider workflow room to survive ordinary queueing.
  timeout: 120_000,
  use: {
    baseURL: process.env.OPENLEEK_E2E_BASE_URL ?? "http://127.0.0.1:3000",
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
  },
});
