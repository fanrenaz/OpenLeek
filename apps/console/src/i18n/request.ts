import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { isConsoleLocale, localeCookie, localeFromAcceptLanguage } from "./config";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requestedLocale = cookieStore.get(localeCookie)?.value;
  const locale = isConsoleLocale(requestedLocale)
    ? requestedLocale
    : localeFromAcceptLanguage((await headers()).get("accept-language"));

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
