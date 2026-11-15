const endpoint = process.env.OPENLEEK_CODEX_HOOK_URL;
const token = process.env.OPENLEEK_CODEX_HOOK_TOKEN;

process.stdout.write(JSON.stringify(await main()));

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    if (!endpoint || !token) return { continue: true };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: input.session_id,
        turnId: input.turn_id,
        cwd: input.cwd,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { continue: true };
    const payload = await response.json();
    const additionalContext = typeof payload.additionalContext === "string"
      ? payload.additionalContext
      : "";
    if (!additionalContext) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  } catch {
    return { continue: true };
  }
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}
