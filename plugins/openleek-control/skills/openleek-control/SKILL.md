---
name: openleek-control
description: Mutate OpenLeek through the private Control MCP. Use for asset draft, publish or deletion operations; Run creation, resume, retry, cancellation or fork; dynamic Context asset changes; and shared LLM configuration changes. Do not use for read-only domain questions, which belong to openleek-docs.
---

# OpenLeek Control

Use this Skill for state changes only. Apply the `$openleek-docs` live source
route first; do not copy static schemas or domain facts into this Skill.

## Authenticate

- Require `OPENLEEK_CONSOLE_ACCESS_PASSWORD` in the environment that starts
  Codex.
- If initialization returns `401 invalid_token`, report that the environment
  variable is missing or stale. Never request, print, log or persist its value.
- Use the private `openleek_control` MCP endpoint.

## Establish the mutation contract

1. Read the current data dictionary through `$openleek-docs`.
2. Require the target Owner to be available. Locate the exact entry,
   `management` binding and Owner revision.
3. Read the concrete target or every referenced asset version. Use the freshest
   draft revision, manifest reference, version reference or LLM configuration
   base revision returned by its Owner.
4. Build candidates from `definitionSchema`, `references` and, for algorithms,
   `programming` context/result contracts. Treat examples as shape guidance
   only.
5. Validate and preview whenever the live management capabilities expose those
   operations.
6. Explain the exact target and persisted effect before the mutation. The
   Codex host enforces approval for writes.
7. Create one opaque idempotency key per logical operation. Reuse it only to
   retry that same operation.
8. Re-read authoritative state after success and report the resulting ID,
   revision, version reference, Run lifecycle or LLM configuration revision.

If any Owner, reference or current revision is unavailable, stop the mutation
and name the missing live dependency. Do not invent a substitute.

## Asset lifecycle

- Save only against the current draft revision when updating an existing ID.
- Publish only the validated current draft revision.
- Draft and version deletion are irreversible tombstones. Default reads and
  new bindings hide them; historical version-reference audit reads remain
  resolvable.
- Never imply that saving or republishing identical content restores a deleted
  ID or version.
- Dynamic Context assets follow the collection actions and current Context
  descriptor revision published by `read_context_catalog`.

## Run lifecycle

- Create a Run only from a complete validated specification whose entire
  reference chain resolves to current, non-deleted published versions.
- Let Run creation bind the fixed Agent runtime model and live Hindsight memory
  revision; do not substitute a remembered revision.
- Resume, retry and cancel only against the current committed manifest
  reference.
- Fork only from the requested committed source manifest and apply only
  supported requested rebindings.
- Report outcomes from committed manifests and committed facts, never from
  transient worker state.

## Shared LLM configuration lifecycle

- Read the current redacted graph and base revision before mutation.
- Validate a patch before persisting it.
- LLM provider, model, offer and route resource deletion is physical deletion
  against `baseRevision`, not an asset tombstone.
- Treat all responses as redacted projections and never seek secret fields.
- Agent inference is fixed by Agent Execution and is not mutable through
  Control. LLM configuration mutations affect Hindsight memory only.
