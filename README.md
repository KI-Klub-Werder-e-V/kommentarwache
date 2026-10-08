# kommentarwache

Self-hosted comment moderation for small organisations. It reads comments from the
platforms you run accounts on, classifies them with a fast decision model and a text
LLM, acts on obvious violations itself, and sends only ambiguous comments to a light
review dashboard. Every model decision is logged, and the same API is available to
coding agents through MCP.

Status: milestone 1 of 8. Stage 1 works end to end against Jev: `POST /v1/moderate`
returns a verdict, everything is stored and replayable, and the eval harness reports
agreement with labelled sets (see `eval/README.md`). No stage 2, dashboard, actions or
platform connectors yet. The plan is in `docs/plan.md`.

## Design in one paragraph

Models classify, code decides. A comment goes through a decision model first (Jev at
launch; Laya, a 322M open model, once a fine-tuned checkpoint exists). Clear cases are
closed or hidden at once. Unsure cases go to a text LLM running locally through Ollama,
which sees the policy, examples and thread context. Only what both stages leave unsure
reaches a human. Raw probabilities are stored for every assessment, so a changed policy
can be replayed over history without calling a model again.

## Requirements

- One Linux server with 16 GB RAM and no GPU is enough, with Docker.
- Node 24 and pnpm for development.

## Try it

```bash
cp .env.example .env            # set DATABASE_URL and TYPESAFE_API_KEY
pnpm install && pnpm build
KW="node packages/server/dist/cli/main.js"
$KW migrate
$KW setup                        # activates Jev with battery v2 and the severity_led policy
$KW token create --name demo     # prints an API token once
pnpm --filter @kommentarwache/server dev

curl -s localhost:8080/v1/moderate \
  -H "Authorization: Bearer kw_..." -H "Content-Type: application/json" \
  -d '{"source":"demo","id":"c1","text":"Did you even read the article? Come on."}'
```

The answer carries the verdict (`ok`, `unsure` or `violation`), the category, the reasons
with their thresholds, and the state: `closed`, or `s2_pending` for anything that needs a
second look. The OpenAPI document is at `/openapi.json`.

## Development

```bash
pnpm install
pnpm build                       # also the typecheck
TEST_DATABASE_URL=postgres://... pnpm test   # or leave it unset to use a Docker container
```

## Licence

Apache-2.0. See `LICENSE`.
