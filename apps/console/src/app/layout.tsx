import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { AppProviders } from "../components/ui/app-providers";
import { ConsoleShell } from "../components/ui/console-shell";
import { consoleSans } from "../components/ui/console-theme";
import "@stoplight/mosaic/themes/default.css";
import "@stoplight/mosaic/styles.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "OpenLeek Console",
  description: "Research operations console for OpenLeek experiment runs and runtime configuration.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  return <html className={consoleSans.variable} lang={locale}>
    <body>
      <NextIntlClientProvider>
        <AppProviders>
          <a className="skip-link" href="#console-main">Skip to content</a>
          <ConsoleShell>{children}</ConsoleShell>
        </AppProviders>
      </NextIntlClientProvider>
    </body>
  </html>;
}
