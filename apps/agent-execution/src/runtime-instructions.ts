import { sha256 } from "./canonical";

export const OPENLEEK_INSTRUCTION_POLICY_VERSION = "openleek-codex-runtime/v5";
export const OPENLEEK_CONTEXT_COMPACTION_POLICY = {
  mode: "auto",
  tokenLimit: 64_000,
  scope: "total",
  prompt: "codex-default",
} as const;

export const OPENLEEK_BASE_INSTRUCTIONS = [
  "Your persistent role, behavioral identity, and objectives come from AGENTS.md.",
  "The current bounded task and current time come from the Turn input.",
  "You operate inside a closed, fictional simulation; its Social and Financial people, accounts, assets, actions, and outcomes do not refer to real-world people, accounts, or assets.",
  "Act as an in-world participant rather than an outside analyst: your actions may create or change the market and social conditions that you and others subsequently observe.",
  "Do not import real-world approval or compliance procedures into ordinary authorized in-world actions; within the simulated world, act according to its stated rules and your role's interests, risk tolerance, relationships, and reputation.",
  "Treat authorized Social and Financial MCP resources as the only authoritative sources of current Social and Financial state.",
  "Perform Social and Financial actions only through authorized MCP tools; only MCP-submitted actions can change Social or Financial state.",
  "Do not infer Social or Financial state or current time from the host filesystem, host clock, or external world.",
  "AGENTS.md is already provided by Codex; do not use shell tools to reread it or inspect Codex configuration.",
  "Load an applicable Skill file at most once when its workflow is actually needed, and do not reread it after compaction.",
  "Do not sleep or poll.",
  "Complete exactly the current Turn without requesting human approval.",
  "After the current Turn is complete, return a concise summary and stop.",
].join("\n");

export const OPENLEEK_BASE_INSTRUCTIONS_DIGEST = sha256(OPENLEEK_BASE_INSTRUCTIONS);

export function renderOpenLeekEnvironmentContext(
  workspacePath: string,
  sandboxMode: "workspace-write" | "danger-full-access",
  maxCallsPerToolPerTurn?: number,
): string {
  const path = xml(workspacePath);
  const filesystem = sandboxMode === "danger-full-access"
    ? '<filesystem><workspace_roots><root>' + path + '</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>'
    : '<filesystem><workspace_roots><root>' + path + '</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="write"><path>' + path + "</path></entry></file_system></permission_profile></filesystem>";
  return [
    ...(maxCallsPerToolPerTurn === undefined ? [] : [
      `<tool_call_budget max_calls_per_tool_per_turn="${maxCallsPerToolPerTurn}">`,
      "  The limit applies independently to each normalized tool name during this Turn.",
      "  Reuse existing tool results and finish the Turn before exhausting a tool's budget.",
      "</tool_call_budget>",
    ]),
    "<environment_context>",
    `  <cwd>${path}</cwd>`,
    "  <shell>bash</shell>",
    "  <timezone>Etc/UTC</timezone>",
    `  ${filesystem}`,
    "</environment_context>",
  ].join("\n");
}

export function instructionPolicyDigest(developerInstructions: string): string {
  return sha256({
    version: OPENLEEK_INSTRUCTION_POLICY_VERSION,
    baseInstructions: OPENLEEK_BASE_INSTRUCTIONS,
    developerInstructions,
    nativeEnvironmentContext: false,
  });
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
