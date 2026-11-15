# Work-pool Next/tRPC Runtime

OpenLeek deploys a Core control plane, independently operated Context projects,
and an independent `experiment-worker` consumer:

```text
Browser -> Console -> Experiment (control plane)
                              -> experiment-worker (PostgreSQL job consumer)
                       -> Agent Execution
                       -> Context Gateway
                              -> any activated Context installation
```

Every service exposes `/health` and `/ready`; Core services also expose their
normal application APIs. Only Console is host-published. A Context descriptor
with schema version 3 advertises `openleek-context-runtime/v2`. Experiment
drives every selected installation through the same Runtime v2 operations and
persists only generic revision and binding projections. Context routers and
owner-specific contracts are never imported by Experiment.

## Ownership and isolation

Experiment owns specifications, run lifecycle, immutable round snapshots,
attempts, Agent jobs/leases, commit ledgers, decisions, manifests, and lineage.
It does not persist posts, exposures, orders, trades, portfolios, or agent
sessions.

Agent Execution and every provisioned Context use distinct owner credentials
and databases. Optional infrastructure is declared by the descriptor and
created by the Provisioner. A Context can own additional projections, but no
other Context may depend on or query them. Console has no database credential
and never performs cross-Context SQL reads.

## Frozen snapshot work-pool protocol

`resume` takes a run-level PostgreSQL advisory lock, reads the committed
manifest once, freezes each selected Context through Runtime v2, and writes one
immutable snapshot plus one Job per declared Agent in the same transaction.
It then returns `running`; it never waits for a provider call or commit.

Workers claim with `FOR UPDATE SKIP LOCKED`, a lease token, and the snapshot's
run-wide `maxConcurrentAgents` cap. They make one single-Agent Agent Execution
call outside the state lock. A lease can be heartbeated or reclaimed after
expiry. Successful jobs retain their result digest; an exhausted job moves the
attempt to `retry_wait` without Context mutation. Manual retry creates a new
attempt from the same snapshot and reuses successful Agent results.

When every Job succeeds, exactly one worker enters the forward-only commit
Saga in declared Agent order:

```text
close all scopes -> settle all Contexts -> seal all Contexts
-> publish Agent decision -> publish all Contexts -> commit manifest
```

Every command has `transitionId`, `stepId`, `payloadDigest`, and an expected
checkpoint reference. Equal key/digest replays the persisted result; a digest
drift returns `IDEMPOTENCY_CONFLICT`. On a crash Experiment reissues the first
incomplete stable command and moves forward; it never performs cross-database
rollback. Pending and sealed Context facts cannot be returned by Console.
Commit failure also enters `retry_wait`, but retry resumes the same ledger and
never re-runs a successful Agent model call. Console polls `roundProgress` and
shows queued, running, retry-wait, and committed state; it still reads only
committed facts.

## Codex and MCP boundary

`agent-execution` is one Codex-only Node service. Public specifications have no
backend selector. Before a Codex thread starts, it materializes each agent's
static `AGENTS.md`, selected Skill bundles under `.agents/skills`, and
`.codex/config.toml`. Agent Execution overrides the
model catalog's coding-agent base instructions with a fixed, versioned
OpenLeek runtime protocol. It disables Codex's native environment context and
supplies a stable workspace, shell, timezone, and filesystem description that
never contains the host's current date. The complete provider context therefore
contains the OpenLeek base instructions, the sanitized environment,
`AGENTS.md`, tool schemas, persisted thread history, and the text rendered from
a published immutable Turn Prompt. Experiment owns the Turn Prompt asset
lifecycle, Run selection, variables, and frozen projection because it is the
experiment's per-round intervention. Agent Execution only consumes that frozen
projection and renders the current simulation UTC date and round. Each
published Agent Blueprint also names an immutable MCP Policy and
zero or more immutable Skill versions. Skills define reusable workflows and
declare required MCP capabilities, but never grant them. Agent Blueprint
publication rejects a Skill whose requirements are not covered by its Policy.
Experiment freezes that Policy with the resolved Population and supplies the
Context-specific tool/resource allow-list when registering the run principal.
Each Context owns its Streamable HTTP MCP endpoint, filters discovery, and
independently rejects unauthorized direct calls or reads. Agent Execution only
writes each per-Agent endpoint and capability header into the workspace. A
fourth Context therefore needs a descriptor, Runtime v2 endpoint, and MCP
surface, but no Experiment or Agent Execution adapter.
When the Codex app-server is hosted outside Docker, the Codex Compose override
bind-mounts one absolute host workspace path into Agent Execution. The service
creates opaque hashed directories in that mount and sends the host-visible path
to app-server, so no container-only pathname is passed across the WebSocket.
That non-loopback app-server listener uses a capability token supplied to Agent
Execution as a deployment secret; firewall or network policy confines it to the
trusted Docker network.

Financial's image builds the Rust N-API matching artifact in a Rust stage and
copies only the `.node` artifact into its Node runtime image. Published feed
algorithms execute in a separate credentialless Python 3.12 service on
`algorithm-mesh`. Social binds each execution to its committed baseline and
provides the runner versioned source, config, deterministic seed, and a
short-lived opaque capability for the corresponding committed lineage. Each
source defines `FeedAlgorithm(config, context)` and receives a read-only
`context["socialHistory"]` reader: `all()` lazily yields complete canonical
Social revision snapshots in lineage order, while `round(round_id)` reads one
committed snapshot. The reader never exposes the executing round's workspace,
Agent actions, or Agent MCP scope.

The runner owns no facts and has no Postgres, Redis, Neo4j, Experiment, Codex,
or provider credential. Its parent process proxies capability-bound history
requests over `algorithm-mesh`; the untrusted algorithm child receives neither
the endpoint nor the capability. The runner creates one algorithm instance per
frozen baseline and invokes its re-entrant `rank(actor_id) -> list[str]` method
concurrently for each active actor. Social validates and stamps the returned
ordered post IDs as exposures before they enter a revision. All other Context
services contain no Python toolchain.

The Console treats activation as the trust boundary for optional Context UI.
A schema-v3 descriptor may publish a browser module path, SHA-256 digest, and
custom-element names. Console fetches that module with the installation secret
server-side, verifies the activated digest, and serves it from a same-origin
proxy. Runtime credentials are never exposed to the browser. Specialized views
remain Context-owned modules; Run lifecycle and committed whole-experiment
facts remain Core-owned.

The production Compose runtime selects immutable standalone artifacts from
`.runtime/prebuilt/current`; it does not mount application source or use Fast
Refresh. `pnpm build:prebuilt` builds from an isolated copy and
`pnpm compose:up` reconciles the selected release across the main `openleek`,
`openleek-financial`, `openleek-social`, and `openleek-news` Compose projects. The
Context Registry owns installation lifecycle and encrypted upstream bearer
credentials; the Provisioner creates optional isolated PostgreSQL/Redis
resources. Context services expose their descriptor, Runtime v2, MCP, and UI
module endpoints on the shared internal `openleek-core-context-plugins` plane.
Experiment, Registry, Gateway, and Console join that plane once; adding another
Context project therefore does not add a Context-specific network dependency to
Core. Owner data networks and optional legacy observer networks remain separate.
Built-in installations are deterministically adopted and verified during
reconciliation. Dynamic Codex sandboxes use one
`openleek-sandbox-context-gateway` network plus a separate provider egress
network, never a Context project's internal network. The
reconciliation entrypoint also loads the narrow Codex user-namespace AppArmor
profile when the Ubuntu host restriction is active, allowing bubblewrap to
isolate Agent shell processes and their `/proc` view without exposing the
provider credential.

## Verification

Run `pnpm run typecheck`, `pnpm test`, `pnpm run verify:compose`, and
`scripts/verify_context_database_isolation.sh` against a running Compose stack.
The provider-backed restart gate is executed only with real deployment
credentials; an unavailable provider is reported as a retryable failure.

The Compose project split pins existing persistent volume names. Never use
`down --volumes`. A protocol cutover that intentionally drops incompatible Run
history must first take an explicit backup and clear only Run/execution state;
published asset libraries remain intact and are migrated through Control APIs.
