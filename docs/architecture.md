# Architecture

This page describes the shape of the system. The build plan with milestones lives in
`docs/plan.md`; what exists today is listed at the bottom.

## Flow

```
connectors (poll / webhook)   REST /v1/moderate   JSONL import
            \                     |                  /
             +---------- ingest + dedupe -----------+
                               |
                 stage 0  rules in code (allow and block lists, banned author, duplicates)
                               |
                 stage 1  decision model: Jev  (Laya, Llama Guard as shadow or parallel)
                               |
                   ok  |  clear violation  |  unsure
                    |          |               |
                 closed     hide now       stage 2: text LLM via Ollama
                               |           (policy, examples, parent post and comment)
                               |               |
                               +------ ok | violation | still unsure
                                        |       |            |
                                     closed   action      human review queue
                                              ladder      (dashboard or agent)
                               |
              append-only log: assessments, decisions, actions  ->  analytics
```

Every stage answers in one vocabulary: `ok`, `unsure` or `violation`, plus a category.

| Stage 1   | Stage 2                               | Outcome                                                              |
| --------- | ------------------------------------- | -------------------------------------------------------------------- |
| ok        | not run                               | Closed                                                               |
| violation | run only if delete or ban is at stake | Hide at once; delete or ban if stage 2 confirms                      |
| violation | ok, unsure or timed out               | Human queue; the hide stays until a human decides                    |
| unsure    | ok                                    | Closed, including mild rudeness that stage 2 judges within tolerance |
| unsure    | violation                             | Hide at most; human queue on platforms that can only delete          |
| unsure    | unsure, timed out or failed           | Human queue                                                          |

## Principles

- Models classify; code decides. Thresholds are named numbers in a versioned policy.
- Raw answers and probabilities are stored for every assessment, so a changed policy can
  be replayed over history without a model call.
- One narrow judgment per question. The versioned model ID is logged with every assessment.
- Author names and IDs are never sent to a model provider.
- The confidence required for an action rises with how hard it is to reverse: hide needs
  stage 1, delete and ban need both stages to agree.

## Providers

One interface, `assess(input) -> answers`, plus a pure mapper per question battery that
turns answers into a verdict. Jev and Laya share the `/v1/systemone` wire format and one
client. A provider has a role: `primary`, `parallel` (disagreement becomes `unsure`) or
`shadow` (logged, never acted on). Shadow is how a Laya checkpoint is measured against
Jev before it takes over.

## Data

Evidence tables (`assessments`, `decisions`, `audit_log`) are insert-only. Config tables
(`batteries`, `policies`, `provider_configs`, `pipeline_configs`) are immutable versions.
The view `comment_outcomes` puts every stage's verdict for a comment side by side, and all
analytics are simple queries on it. See `packages/server/migrations/`.

## What exists today

- Milestone 0: schema, the policy router ported from the prototype with its tests, and
  `kw import-prototype`, which loads the prototype's stored results and reproduces its
  verdict counts.
- Milestone 1: the System One client and provider (Jev and Laya share it), battery v2
  (choice-only: sentiment, attack, target, severity, spam) with its router, idempotent
  ingest and stage 1, `POST /v1/moderate` with API tokens and an OpenAPI document, and the
  eval harness (`kw eval`, `kw replay`, `kw labels import`). Results in `eval/README.md`.
- Milestone 2: stage 2 through Ollama with a JSON schema and log-probability confidence,
  the combination table above as code, jobs on graphile-worker enqueued in the same
  transaction as the decision (stage 2 serial, most harmful first), deadlines with a
  reconciler every minute, and `kw stage2-run` for evaluation.
- Milestone 3: the dashboard under `/app` (queue, comment timeline with one-click
  decision, decision log, analytics), moderator accounts with scrypt passwords and
  server-side sessions, `decideComment` as the one path for human decisions, and the
  hash-chained audit log (`kw audit verify`).
- Milestone 4: the actions engine. `ladder()` is pure code; `applyLadder` applies the
  connector's capabilities and the source's modes (off, dry_run, propose, auto) and
  hourly cap, records every action as a row before anything happens, executes the
  automatic ones, and queues the rest for a human (proposed, unsupported, failed).
  Undo for hide and ban; deletes a human overturns are marked. A Sources page and
  `kw source modes` set the modes. The `fake` connector is an in-memory platform.
- Milestone 5: connectors. Credentials encrypted at rest (`KW_SECRET_KEY`), a poll task
  every two minutes that ingests new comments and queues stage 1, and connectors for the
  generic site (signed action callbacks), YouTube (`commentThreads` and
  `setModerationStatus`), Facebook Pages and Instagram (Graph API v26.0). `kw source-add`,
  `kw source-test`, `kw source-poll`. See `docs/connectors.md`.
- Milestone 6: the agent surface. One command catalogue in the contract package; REST
  routes and MCP tools are generated from it and a parity test keeps them equal. Tokens
  carry scopes (moderate, review, actions, admin); without `actions`, delete and ban
  become proposals. MCP over streamable HTTP at `/mcp` and over stdio through the
  `kommentarwache-mcp` package. Skills and plugin manifests for Claude Code, Cowork,
  Codex, ChatGPT and opencode. See `docs/agents.md`.
