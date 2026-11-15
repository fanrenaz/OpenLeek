export const localeCookie = "openleek_console_locale";
export const locales = ["en", "zh"] as const;

export type ConsoleLocale = typeof locales[number];

export function isConsoleLocale(value: unknown): value is ConsoleLocale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

export function localeFromAcceptLanguage(value: string | null): ConsoleLocale {
  return value?.toLowerCase().startsWith("zh") ? "zh" : "en";
}
