---
name: openleek-docs
description: Answer OpenLeek domain, contract, asset, Run, evidence, committed-fact, Context, shared Hindsight LLM configuration, and Agent runtime capability questions from the private live Control MCP. Use for read-only inspection, schema discovery, source routing, current revisions, reference resolution, and explaining what the running platform accepts or returns.
---

# OpenLeek Docs

Treat the live Control MCP as the source of truth. This Skill is read-only: it
must not invoke a mutation, even when the available MCP also exposes writes.

## Route every question to live sources

1. Reuse a data dictionary already read in this thread only when the relevant
   Owner is available and its revision is still known to be current.
2. Otherwise call `read_data_dictionary`. Check the requested Owner's
   `available` state and record its exact `revision`.
3. For a dynamic Context, call `read_context_catalog` and use that Context's
   current descriptor revision, collection metadata and capability metadata.
4. For concrete assets, Runs, manifests, progress, usage, runtime evidence,
   committed facts, shared Hindsight LLM configuration or Agent runtime capability, use the
   matching read surface named by the entry's `management` binding.
5. For a live Run observer head or committed round timeline, call
   `read_run_observer`. For broker-like snapshot, trade, or order reads, call
   `read_financial_observer`. For timeline, post, profile, or relationship
   reads, call `read_social_observer`.
6. Omit `manifestRef` for the current committed financial or social view.
   Supply an exact committed manifest reference for historical state. Never
   substitute a candidate revision or an uncommitted round reference.
7. Expand only entries, references and live records needed for the question.
   Do not load the full catalog repeatedly.
8. If an Owner or referenced record is unavailable, state the exact missing
   source and bound the answer. Never fill the gap from model memory.

## Interpret dictionary entries

- `definitionSchema` is the machine contract. Use it for fields, requiredness,
  enums, limits and nesting.
- `references` identifies cross-entry version references. Resolve the relevant
  target entry before explaining a binding.
- `examples` show shape only. They are not selectable IDs, current defaults or
  permission to create state.
- `programming` defines the executable class, methods, context/result schemas,
  imports and resource limits for algorithm assets.
- `entryKind` distinguishes assets, inputs, aggregates, projections, evidence
  and configuration.
- `management.surface`, `key`, `idField` and `capabilities` describe the
  generic live management surface. They are not literal MCP tool names.

## Report provenance

For contract answers, name the Owner, entry ID and Owner revision used. For
Context answers, include the Context ID and descriptor revision. For concrete
Run or shared LLM answers, include the returned Run/manifest/config revision
that makes the answer current.

Observer answers should name the Run and committed manifest or round returned.
Keep cursor pagination intact and distinguish the current committed head from
an explicitly selected historical manifest.

Distinguish clearly between:

- schema or capability;
- a current live record;
- an immutable historical version;
- an example from the dictionary;
- an inference derived from those sources.

Never expose credentials, unredacted provider values, prompts, asset bodies
or algorithm source unless a dedicated read response explicitly returns that
material and the user's request requires it.
