import { expect, test } from "@playwright/test";

const providerEnabled = process.env.OPENLEEK_RUN_SANDBOX_E2E === "1";

test("production Console publishes the fixed native DeepSeek runtime", async ({ page }) => {
  test.skip(!providerEnabled, "set OPENLEEK_RUN_SANDBOX_E2E=1 to run the real Compose/provider suite");
  if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error("DEEPSEEK_API_KEY is required for the real provider suite");
  if (!process.env.OPENLEEK_SANDBOX_APP_SERVER_TOKEN?.trim()) {
    throw new Error("OPENLEEK_SANDBOX_APP_SERVER_TOKEN is required for the real provider suite");
  }
  const accessPassword = process.env.OPENLEEK_CONSOLE_ACCESS_PASSWORD?.trim();
  if (!accessPassword) throw new Error("OPENLEEK_CONSOLE_ACCESS_PASSWORD is required for the real provider suite");

  await page.goto("/");
  if (await page.getByRole("heading", { name: "Private console" }).isVisible()) {
    await page.getByLabel("Password").fill(accessPassword);
    await Promise.all([
      page.waitForURL((url) => url.pathname !== "/login"),
      page.getByRole("button", { name: "Continue" }).click(),
    ]);
  }
  await page.goto("/runs/new");
  await expect(page.getByRole("heading", { name: "Configure research run" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Agent model")).toHaveValue("deepseek-v4-flash");
  await expect(page.getByLabel("Memory configuration revision")).not.toHaveValue("");
  await expect(page.locator("body")).not.toContainText("DEEPSEEK_API_KEY");
});
