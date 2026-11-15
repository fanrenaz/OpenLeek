import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENLEEK_BASE_INSTRUCTIONS,
  OPENLEEK_CONTEXT_COMPACTION_POLICY,
  OPENLEEK_INSTRUCTION_POLICY_VERSION,
} from "../src/runtime-instructions";

test("runtime v5 frames Agents as in-world participants while keeping authoritative state bounded", () => {
  assert.equal(OPENLEEK_INSTRUCTION_POLICY_VERSION, "openleek-codex-runtime/v5");
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /current bounded task/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /closed, fictional simulation/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /in-world participant rather than an outside analyst/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /actions may create or change the market and social conditions/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /Do not import real-world approval or compliance procedures/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /role's interests, risk tolerance, relationships, and reputation/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /only MCP-submitted actions can change Social or Financial state/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /AGENTS\.md is already provided by Codex/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /do not use shell tools to reread/);
  assert.match(OPENLEEK_BASE_INSTRUCTIONS, /Do not sleep or poll/);
  assert.doesNotMatch(OPENLEEK_BASE_INSTRUCTIONS, /ignore (?:all )?(?:laws?|legal|morals?|ethical)/i);
  assert.doesNotMatch(OPENLEEK_BASE_INSTRUCTIONS, /local journals|helper scripts|create.*Skills/i);
  assert.doesNotMatch(OPENLEEK_BASE_INSTRUCTIONS, /persistent thread goal/i);
  assert.deepEqual(OPENLEEK_CONTEXT_COMPACTION_POLICY, {
    mode: "auto",
    tokenLimit: 64_000,
    scope: "total",
    prompt: "codex-default",
  });
});
