const endpoint = process.env.OPENLEEK_CODEX_TOOL_BUDGET_HOOK_URL;
const token = process.env.OPENLEEK_CODEX_HOOK_TOKEN;
const disabledTools = new Set([
  "apply_patch",
  "Edit",
  "Write",
  "update_plan",
  "request_user_input",
  "view_image",
  "create_goal",
  "get_goal",
  "update_goal",
  "spawn_agent",
  "send_input",
  "wait_agent",
  "resume_agent",
  "close_agent",
  "Agent",
]);

process.stdout.write(JSON.stringify(await main()));

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    if (disabledTools.has(input.tool_name)) return deny(`Tool '${input.tool_name}' is disabled for OpenLeek simulation Agents.`);
    if (!endpoint || !token) return deny("Tool call budget service is unavailable.");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: input.session_id,
        turnId: input.turn_id,
        cwd: input.cwd,
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return deny("Tool call budget service is unavailable.");
    const decision = await response.json();
    if (decision.allowed === true) return {};
    const detail = decision.toolName && decision.limit
      ? `Tool '${decision.toolName}' reached its per-Turn limit of ${decision.limit} calls. Finish using existing results.`
      : "Tool call budget exhausted. Finish using existing results.";
    return deny(detail);
  } catch {
    return deny("Tool call budget service is unavailable.");
  }
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}
