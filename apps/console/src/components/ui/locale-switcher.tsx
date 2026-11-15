"use client";

import { FormControl, MenuItem, Select, type SelectChangeEvent } from "@mui/material";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { localeCookie, type ConsoleLocale } from "../../i18n/config";

export function LocaleSwitcher() {
  const locale = useLocale() as ConsoleLocale;
  const router = useRouter();
  const t = useTranslations("Navigation");

  function change(event: SelectChangeEvent<ConsoleLocale>) {
    const next = event.target.value as ConsoleLocale;
    document.cookie = `${localeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.refresh();
  }

  return <FormControl size="small" fullWidth>
    <Select aria-label={t("language")} value={locale} onChange={change} sx={{ bgcolor: "rgba(255,255,255,.72)", fontSize: ".82rem" }}>
      <MenuItem value="en">English</MenuItem>
      <MenuItem value="zh">中文</MenuItem>
    </Select>
  </FormControl>;
}
