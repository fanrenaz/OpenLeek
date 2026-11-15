import assert from "node:assert/strict";
import test from "node:test";
import {
  base64DecodedByteLength,
  publishedVersionHref,
  sanitizeRawData,
} from "../src/components/assets/published-version-details";

test("published raw data preserves text while omitting base64 file payloads", () => {
  const value = {
    versionRef: "skill:example:v1",
    files: [
      { path: "SKILL.md", encoding: "utf8", content: "# Example" },
      { path: "asset.bin", encoding: "base64", content: "AAECAw==" },
    ],
  };

  assert.deepEqual(sanitizeRawData(value), {
    versionRef: "skill:example:v1",
    files: [
      { path: "SKILL.md", encoding: "utf8", content: "# Example" },
      {
        path: "asset.bin",
        encoding: "base64",
        content: "[base64 content omitted · 4 bytes]",
      },
    ],
  });
});

test("published Skill binary sizes use decoded bytes", () => {
  assert.equal(base64DecodedByteLength(""), 0);
  assert.equal(base64DecodedByteLength("Zg=="), 1);
  assert.equal(base64DecodedByteLength("Zm8="), 2);
  assert.equal(base64DecodedByteLength("Zm9v"), 3);
  assert.equal(base64DecodedByteLength("AAECAw=="), 4);
});

test("published asset references use Individual Level routes", () => {
  assert.equal(
    publishedVersionHref("agentBlueprintVersionRef", "agent-blueprint:example:v1"),
    "/assets/individual/agent-blueprints/versions/agent-blueprint%3Aexample%3Av1",
  );
  assert.equal(
    publishedVersionHref("financialInitialStatePresetVersionRef", "financial-preset:example:v1"),
    "/assets/individual/financial-presets/versions/financial-preset%3Aexample%3Av1",
  );
  assert.equal(
    publishedVersionHref("agentsMdVersionRef", "agents-md:example:v1"),
    "/assets/individual/agents-md/versions/agents-md%3Aexample%3Av1",
  );
  assert.equal(
    publishedVersionHref("skillVersionRef", "skill:example:v1"),
    "/assets/individual/skills/versions/skill%3Aexample%3Av1",
  );
  assert.equal(
    publishedVersionHref("mcpPolicyVersionRef", "mcp-policy:example:v1"),
    "/assets/individual/mcp-policies/versions/mcp-policy%3Aexample%3Av1",
  );
});
