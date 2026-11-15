import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTranslator } from "next-intl";

type Messages = {
  TurnPrompts: {
    sourceHelp: string;
  };
};

function messages(locale: "en" | "zh"): Messages {
  return JSON.parse(
    readFileSync(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), "utf8"),
  ) as Messages;
}

test("Turn Prompt placeholder help is valid ICU and preserves double braces", () => {
  for (const locale of ["en", "zh"] as const) {
    const translate = createTranslator({ locale, messages: messages(locale) });
    assert.match(translate("TurnPrompts.sourceHelp"), /\{\{utcDate\}\}/);
    assert.match(translate("TurnPrompts.sourceHelp"), /\{\{roundId\}\}/);
  }
});
