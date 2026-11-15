# OpenLeek Control MCP

External Codex clients can connect to the stateless Control profile with the
same password used to sign in to the OpenLeek Console:

```toml
[mcp_servers.openleek_control]
url = "https://openleek.noesis-ai.com/api/control/mcp"
bearer_token_env_var = "OPENLEEK_CONSOLE_ACCESS_PASSWORD"
```

The Control profile exposes owner-backed reads and asset mutations, Run
controls, and shared LLM configuration management. Its committed observer
tools provide Run timelines plus broker-like financial and social-client
views without depending on browser page state.

## Private Codex plugin

The repository includes the `openleek-private` marketplace and the
`openleek-control` plugin. The plugin contains two complementary Skills:

- `openleek-docs` routes read-only questions through the live data dictionary,
  Context catalog, current owner revisions, Runs, evidence and redacted
  shared Hindsight LLM configuration.
- `openleek-control` performs approved asset, Run, Context and Hindsight LLM
  mutations after applying the same live source route. It does not duplicate
  domain schemas.

Register the repository checkout as a local
marketplace, then install the plugin:

```bash
codex plugin marketplace add <path-to-openleek-repository>
codex plugin add openleek-control@openleek-private
```

Export `OPENLEEK_CONSOLE_ACCESS_PASSWORD` from an approved secret source before
starting Codex. Do not store its value in the repository, plugin, shell history,
or prompts. Start a new Codex session after installing or updating the plugin
so its Skill and MCP tools are loaded.

After pulling a plugin update, rerun
`codex plugin add openleek-control@openleek-private` and start a new session.

The plugin allows read tools without an approval prompt and requests approval
for writes and destructive actions. A missing or stale password leaves Codex
usable but causes the Control MCP connection to return `401 invalid_token`.
