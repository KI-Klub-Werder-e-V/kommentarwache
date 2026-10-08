---
name: kommentarwache-setup
description: Install and configure kommentarwache, the self-hosted comment moderation service; use when asked to set it up, connect a platform, create tokens or moderator accounts, or choose how far it may act on its own.
---

# Setting up kommentarwache

kommentarwache moderates comments in two stages (a decision model, then a local text LLM
for the unsure band) and sends what both leave unsure to a human review queue. Models
classify; code decides; every decision is a row.

## Install

```bash
git clone <repo> && cd kommentarwache
cp .env.example .env         # DATABASE_URL, TYPESAFE_API_KEY, KW_SECRET_KEY, OLLAMA_URL
docker compose up -d db      # or point DATABASE_URL at an existing Postgres
pnpm install && pnpm build
KW="node packages/server/dist/cli/main.js"
$KW migrate
$KW setup --stage2-model gemma4:12b-it-qat     # Jev as stage 1, Ollama as stage 2
$KW moderator create --email <email> --name <name> --password '<10+ chars>'
$KW token create --name <agent-name> --scopes moderate,review
node packages/server/dist/main.js             # API + worker + dashboard at /app
```

`KW_SECRET_KEY` is 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
Without `TYPESAFE_API_KEY` stage 1 cannot run; without Ollama, unsure comments wait for a human.

## Connect a platform

See `docs/connectors.md` for each platform's credentials and gates. Then:

```bash
$KW source-add --kind youtube --name "<name>" --config '{...}' --secrets '{...}'
$KW source-test --source "<name>"
$KW source modes --source "<name>" --hide dry_run --delete off --ban off
```

Every source starts with all actions off. Recommend a dry run of one to two weeks before
`auto`; the dashboard's Sources page and the analytics show what would have happened.
Delete and ban only ever fire when both stages agree; hide needs stage 1 alone.

## Token scopes

- `moderate`: submit comments (`moderate_comment`)
- `review`: queue, comment detail, decide, hide, undo, analytics, policy, log
- `actions`: delete and ban (without it, those become proposals for a moderator)
- `admin`: source modes

## Checks

- `$KW audit verify` walks the audit chain.
- `GET /healthz` is liveness; `/openapi.json` documents the API; `/mcp` is the MCP endpoint.
- `kw report --connector <name>` after `kw eval` shows agreement with a labelled set.
