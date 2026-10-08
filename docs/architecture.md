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

Milestone 0: schema, the policy router ported from the prototype with its tests, and
`kw import-prototype`, which loads the prototype's stored results and reproduces its
verdict counts.
