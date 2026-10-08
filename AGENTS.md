# Working in this repo

kommentarwache is a self-hosted comment-moderation service. Models classify, code decides.
Read `README.md` for what it does and `docs/architecture.md` for how the pieces fit.

## Commands

```bash
pnpm install
pnpm build                 # tsc -b for all packages; also the typecheck
pnpm test                  # vitest, per package; pipeline tests need Postgres (see below)
pnpm format                # prettier
pnpm --filter @kommentarwache/server kw -- <command>   # the kw CLI from source
```

Tests that touch the database use `TEST_DATABASE_URL` when set, otherwise a throwaway
Postgres via Testcontainers (needs Docker). Each test file gets its own schema.

## Rules that are easy to break

- Models never decide. Every threshold is a named number in a versioned policy, and every
  routing function is pure and tested without a model.
- Raw answers and probabilities are stored for every assessment. Never store only the verdict.
- Author names and author IDs are never sent to a model provider. Only comment text and
  thread context go into a model request.
- Evidence tables (`assessments`, `decisions`, `actions`, `audit_log`) are insert-only.
  Correct a decision by inserting a new one that overrides the old.
- Config tables (`policies`, `batteries`, `provider_configs`, `pipeline_configs`) are
  immutable versions. Activate a new row instead of editing the old one.
- No real people's comments in the repo. `eval/local/` is git-ignored for that.
- Imports use `.js` extensions (`moduleResolution: nodenext`). `import type` for types.

## Layout

```
packages/contract   Zod schemas shared by server, MCP shim and clients
packages/server     pipeline, providers, policy, connectors, actions, api, dashboard, cli
packages/mcp        stdio MCP shim over the REST API (milestone 6)
skills/             SKILL.md files for coding-agent hosts
training/           Python: Laya export, fine-tune, calibration, laya-serve image
eval/sets/          public labelled sets; eval/local/ holds private ones
```
