# kommentarwache: plan for a new open-source moderation repo

## Context

The `ContentModeration/` test build in the Typesafe repo showed that comment moderation works as a few narrow Jev questions combined in code: 23 of 24 expected verdicts, against 13 of 24 for "flag anything negative". On 357 real Facebook comments a blind second reviewer agreed with every approve (40 of 40) but only half the reviews (20 of 40) and two thirds of the flags (26 of 38). So auto-approving is safe, and the review and flag bands are where a second model and a human are needed.

The goal now is a standalone open-source product for the KI Klub Werder GitHub organisation: a service that runs 24/7 on a small 16 GB server, moderates obvious violations on its own, sends only ambiguous comments to a light dashboard, logs every decision, and installs into coding agents as a plugin.

### How the deep research compares with the test build

| Topic                                            | Deep research says                                    | Test build found                                                                     | Plan follows                                                                     |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Sentiment vs. violation                          | Keep them separate                                    | Confirmed: naive policy got 13 of 24                                                 | Both                                                                             |
| Who decides                                      | Model classifies, code decides                        | `policy.py` does exactly this; `--reroute` re-decides without inference              | Both                                                                             |
| Question shape                                   | One 7-class `policyClass` choice plus 0 to 4 severity | Narrow questions worked; the report's `score({min,max})` sample is not valid Jev     | Test build                                                                       |
| Thresholds                                       | Per category, not one global                          | Hostile review at 0.35 was too low for political threads                             | Both                                                                             |
| Missing categories                               | Spam, personal data                                   | Bare links leaked into severity; public-figure criticism scored as a personal attack | Add spam question, split `target`                                                |
| Self-hosted model                                | gpt-oss-safeguard-20b                                 | Not tested                                                                           | Neither: 14 GB, too heavy for this server. Laya (322M) and Llama Guard 3 instead |
| Stack                                            | TypeScript, Zod, Postgres                             | Python, JSONL files                                                                  | Research (your choice)                                                           |
| Platform actions                                 | Lists APIs; several details wrong (see Connectors)    | Comments were scraped from the browser; no actions possible                          | Official APIs, re-verified                                                       |
| Dashboard, audit log, analytics, agent packaging | Named as needed                                       | None                                                                                 | New work                                                                         |

### Decisions you made

- Location: `/home/tim/Documents/KI Klub Werder/Angebote/kommentarwache/`, a new folder with its own git repo. Git is never initialised in `Angebote/` itself, which holds client offers and a plaintext credentials file.
- Apache-2.0. TypeScript, Node, Postgres.
- Jev is the decision model at launch, with a built-in workflow to move to Laya once enough labelled data exists. Llama Guard via Ollama is a third provider; providers can run in parallel.
- The system may hide, delete and ban on its own.
- Named moderator accounts.
- Sources: generic REST and webhook, YouTube, Facebook Pages and Instagram first; then every platform with a usable moderation API.

## What gets built

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

Principles carried over from the test build:

- Models classify; code decides. Thresholds are named numbers in a versioned policy.
- Raw answers and probabilities are stored for every assessment, so a new policy can be replayed over history without a model call. Activating a policy shows the replay diff first ("14 more deletes in the last 30 days").
- One narrow judgment per question. The versioned model ID is logged with every assessment.
- Author names and IDs are never sent to a model provider.

## Pipeline

Every stage returns `ok`, `unsure` or `violation` plus a category.

| Stage 1   | Stage 2                               | Outcome                                                                        |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| ok        | not run                               | Closed                                                                         |
| violation | run only if delete or ban is at stake | Hide at once; delete or ban if stage 2 confirms                                |
| violation | ok, unsure or timed out               | Human queue; the hide stays until a human decides                              |
| unsure    | ok                                    | Closed. This includes mild rudeness that stage 2 judges to be within tolerance |
| unsure    | violation                             | Hide at most; human queue on platforms that can only delete                    |
| unsure    | unsure, timed out or failed           | Human queue                                                                    |

Robustness:

- Ingest is idempotent: one row per platform comment ID. An edited comment restarts at stage 1 and cancels actions not yet executed.
- A retried job reuses the stored assessment instead of calling the model again.
- Each state change is one database transaction that also enqueues the next job. A reconciler re-queues anything past its deadline.
- If Jev is down, comments wait (default 2 hours) instead of flooding the human queue. A fallback provider never authorises delete or ban.
- Stage 2 is one serial queue, most harmful first. Each comment has a deadline (default 15 minutes); if the queue cannot meet it, the least harmful items go to a human straight away.
- Stage 2 does not see stage 1's verdict, so it gives an independent opinion.

## Decision providers (the model-agnostic part)

One interface, `assess(input) -> answers`, plus a pure mapper per question battery that turns answers into `ok / unsure / violation`. The mapper puts every model into one verdict space, which is what makes parallel and shadow comparison possible.

| Provider                   | Covers                                                  | Notes                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SystemOneProvider`        | Jev and Laya                                            | Same `/v1/systemone` wire format; only URL, key, calibration and battery differ. Own small fetch client, because the TypeSafe JavaScript SDK docs show no custom base URL |
| `OllamaGuardProvider`      | Llama Guard 3 (1B or 8B); Shieldstral 3B as a candidate | Raw prompt with our own categories; P(unsafe) from the label token's log-probabilities (Ollama 0.12.11 or newer)                                                          |
| `LlmJudgeProvider`         | Stage 2                                                 | Ollama or any OpenAI-compatible endpoint; JSON-schema output validated with Zod; thinking mode off                                                                        |
| `OpenAIModerationProvider` | Optional free extra signal                              | Fixed categories with scores, German supported                                                                                                                            |

Roles per provider: `primary`, `parallel` (disagreement becomes `unsure`) or `shadow` (logged, never affects the verdict).

Question battery v2 is choice-only with neutral option keys, because that is the shape Laya handles best and it makes Jev's answers directly usable as Laya training targets: severity as a four-way choice, hostility as a choice, a new spam choice, and `target` split into other commenter, public figure, group. Milestone 1 checks this battery against the existing one on our labelled sets. If it is worse on Jev, the existing battery drives verdicts and v2 runs as a shadow to collect training targets (cost is negligible).

Not used: Perspective API (shuts down after 31 Dec 2026).

### Memory budget on the 16 GB server

| Component                                                            | At launch (Jev) | After Laya promotion  |
| -------------------------------------------------------------------- | --------------- | --------------------- |
| Postgres, Node service, OS                                           | about 2 GB      | about 2 GB            |
| Stage-2 LLM: `gemma4:12b-it-qat` (7.2 GB) or `ministral-3` 8B (6 GB) | 7 to 8 GB       | 7 to 8 GB             |
| `laya-serve`, one multilingual checkpoint                            | none            | about 2 GB (estimate) |
| Llama Guard 3 1B (optional)                                          | about 2.5 GB    | about 2.5 GB          |

Ollama keeps one model loaded at a time. Stage 2 is expected to take roughly 30 to 60 seconds per ambiguous comment on an old CPU. That is an estimate; milestone 2 measures it on the real server. `gemma3:4b` (3.3 GB) is the fallback if it is too slow.

## Policy and action ladder

You chose full autonomy. The ladder below is how I propose to implement it; the rule is that the confidence required rises with how hard the action is to reverse.

| Action | Fires when (defaults, configurable per source)                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Hide   | Stage 1 is confident of a violation. Reversible, so it fires at once.                                                                          |
| Delete | Both stages say violation with the same category, and the category is on the delete list: threat, doxxing, dehumanising slur, scam spam.       |
| Ban    | A threat or scam confirmed by both stages, or three confirmed violations by one author in 30 days. Violations a human overturned do not count. |

- Why delete and ban need both models: a third of first-stage flags were not confirmed by a second reviewer in our test, and deletes cannot be undone.
- Platforms without hide: what would have been a hide becomes a one-click proposal in the review queue instead of a delete.
- Each source has a mode per action type: `off`, `dry_run`, `propose` or `auto`. The installer sets them during setup; there is no hidden default. My recommendation is two weeks of `dry_run` per source before switching to `auto`, because our only real-world data is one English US Facebook thread. The dashboard shows measured precision from the dry run to inform the switch. This is a recommendation in the rollout, not a lock in the code.
- Never automatic: comments imported as backfill, allow-listed authors, comments whose text changed since assessment.
- Safety nets: an hourly cap per source that drops `auto` to `propose` and alerts when hit; a global kill switch; undo where the platform allows it. Wrong deletes are marked "overturned" and counted with undos, so delete errors stay visible.
- A small daily sample of auto-approved and auto-actioned comments goes to a low-priority audit queue (default 10 a day, configurable). It is the only way to measure what the models miss.

## Laya migration workflow

1. Collect: every Jev assessment keeps the exact state, questions and full probabilities. Human decisions are gold labels; stage-2 results are silver.
2. Readiness panel in the dashboard: labelled counts against targets (start: 1,200 cases, at least 150 human-confirmed violations, which will be the bottleneck).
3. Export: `kw dataset export` writes Laya's training format (`state`, `questions`, `expected`). `expected` is Jev's distribution, replaced by the human label where one exists. Split by thread and by time. The test split is human-labelled only and frozen.
4. Train off the server: a notebook in `training/` for Kaggle's free GPUs (about 4 to 5 hours at the published size), then fit calibration temperatures.
5. Gate 1, offline, against Jev on the same test set: missed-violation rate, clear-band precision, calibration error, share sent to stage 2, and latency on the real server. Thresholds in config.
6. Shadow: `laya-serve` runs as a shadow provider for at least two weeks. Every case where Laya would have acted and Jev did not, or Laya said ok and the final verdict was a violation, goes to a human.
7. Gate 2: all such cases reviewed and the overturn rate within target.
8. Promote: a named moderator activates a pipeline config with Laya primary and Jev as shadow. Delete and ban drop to `propose` for a probation week.
9. Rollback: reactivate the previous config. Comment text stops leaving the server only once the Jev shadow is switched off.

## Data model (Postgres)

Evidence tables are insert-only. Config tables are immutable versions.

- `actors` (moderators and agent tokens, each token owned by a moderator), `sessions`
- `connectors`, `connector_action_modes` (mode and hourly cap per action type), `authors`
- `ingest_events` (raw payloads, deduplicated), `comments` (text, permalink, revision, pipeline state, deadline, final verdict)
- `batteries`, `policies`, `provider_configs`, `pipeline_configs` (which provider has which role)
- `assessments` (comment, provider, stage, role, raw answers, latency, tokens, cost)
- `decisions` (comment, stage `s1 / s2 / human`, verdict, category, reasons, actor, which decision it overrides)
- `review_items` (reason: both unsure, stages disagree, stage-2 timeout, provider failure, unsupported action, audit sample, shadow difference)
- `actions` (type, mode, state, idempotency key, undo and overturn links)
- `audit_log` (hash-chained: logins, config changes, manual actions)
- `dataset_exports`, `dataset_items`, `evaluations`
- View `comment_outcomes`: one row per comment with stage-1, stage-2, human and final verdicts and whether a human had to read it

## Analytics and dashboard

Analytics, each a simple query on `comment_outcomes` and `actions`:

- Flagged at stage 1; flagged at stage 2; changed between stage 1 and stage 2, as a from-to matrix
- Human overrides of model verdicts, by stage and category
- Automatic actions by type, with undone and overturned counts
- Share of comments a human had to read, broken down by reason (the headline number)
- Volume per day and source; provider latency, errors, tokens and cost
- Laya readiness and shadow disagreement

Dashboard pages, server-rendered with no single-page app: Queue, Comment detail (timeline of assessments, decisions and actions, with a link to the comment on the platform), Log (searchable), Analytics, Sources, Policy (with replay preview), Moderators.

## API and agent surface

A single command registry defines every operation once. Each command is exposed as a REST route, an MCP tool and a dashboard handler, and each writes the audit log with who acted and through which channel. A test asserts that every command has all three.

- REST: `POST /v1/moderate` returns the stage-1 result in under a second, or `pending` with a status URL and optional callback when stage 2 is needed. Plus batch ingest, queue, decide, undo, log, analytics, policy read, replay and activate, source management, webhooks.
- MCP server: streamable HTTP at `/mcp` on the service, and stdio via `npx -y kommentarwache-mcp --stdio` (a thin shim over REST that needs no database).
- Agent tokens default to "resolve and hide". Delete and ban through an agent become proposals unless the token is explicitly scoped for them, because agents read attacker-written comment text while holding credentials.
- Skills: `kommentarwache-setup`, `review-queue`, `tune-policy`, `laya-migration`.

### Packaging per agent host (verified 2026-10-06)

| File                                                                         | Read by                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` | Claude Code, Cowork (Codex also reads the marketplace file) |
| `plugin.json`, `mcp.json` at the root ("Agent Plugins 1.0")                  | Codex, ChatGPT, VS Code, Cursor                             |
| `skills/<name>/SKILL.md`, using only `name` and `description` frontmatter    | All hosts                                                   |
| `AGENTS.md`                                                                  | Agents working inside the repo                              |
| `docs/opencode.json.example`                                                 | opencode (no plugin install; copy one MCP block)            |

- No hooks, sub-agents or `bin/` folder in the plugin: several hosts ignore them and Cowork refuses a plugin with `bin/`.
- Static bearer token covers Claude Code, Codex and opencode and ships first. ChatGPT and Cowork or claude.ai connectors need OAuth 2.1 and a public HTTPS URL; that is milestone 8.
- Cowork cannot ask for a per-install server URL, so Cowork users add the server as a custom connector by hand.

## Connectors

Each connector declares capabilities (poll, webhook, hide, unhide, delete, ban, unban, hold, approve) and implements only those. Polling is the default everywhere because the server may have no public URL; webhooks are opt-in.

### Major social networks (verified against official docs, 2026-10-06)

| Platform            | Hide (reversible)                | Remove others' comments                       | Ban author                  | Gate for a small nonprofit                                       | Cost                                                                            |
| ------------------- | -------------------------------- | --------------------------------------------- | --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| YouTube             | `heldForReview`                  | `rejected` (one-way)                          | `banAuthor` with `rejected` | Google OAuth verification for the sensitive scope (weeks)        | Free, 10,000 units/day; a moderation call costs 50 and covers up to 50 comments |
| Facebook Pages      | `is_hidden`                      | Delete                                        | Block and unblock           | Standard Access is enough for your own Page                      | Free                                                                            |
| Instagram           | `hide`                           | Delete                                        | None                        | Professional account; webhooks need App Review, polling does not | Free                                                                            |
| Threads             | Hide, plus a real approval queue | None                                          | None                        | Low for polling                                                  | Free                                                                            |
| TikTok              | Hide and unhide                  | None                                          | None                        | Company-style developer vetting plus an access form              | Free                                                                            |
| X                   | Hide replies to your own posts   | None                                          | Enterprise plan only        | None                                                             | Pay per use, $0.005 per read and per hide                                       |
| Reddit              | Remove (reversible)              | Remove, spam                                  | Ban with duration           | Manual approval for every new app; outcome uncertain             | Free up to 100 requests/minute                                                  |
| LinkedIn            | None                             | Delete (unproven for other members' comments) | None                        | "Commercial use cases only": a real risk for a Verein            | Free                                                                            |
| Bluesky             | Hide reply                       | None                                          | Block (public)              | None                                                             | Free                                                                            |
| Telegram            | None                             | Delete in the linked discussion group         | Ban, restrict, unban        | None                                                             | Free                                                                            |
| Pinterest, Snapchat | No comment API                   |                                               |                             |                                                                  |                                                                                 |

Corrections to the Perplexity report: TikTok does have a comment API, but hide-only; YouTube's `comments.delete` only works on your own comments; Instagram webhooks need Advanced Access; blocking on X is Enterprise-only; Reddit no longer issues self-service keys.

### Community, chat and self-hosted platforms (verified 2026-10-06)

Most approval gates do not apply here, because each installer registers their own bot or app.

| Platform  | Hide (reversible)   | Delete                             | Ban or timeout                          | Hold, approve, spam           | Gate and cost                                                 |
| --------- | ------------------- | ---------------------------------- | --------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Discord   | None                | Yes                                | Ban, kick, timeout up to 28 days        | None                          | Free bot; message-content intent is a toggle                  |
| Telegram  | None                | Yes, within 48 hours               | Ban, restrict with expiry               | None                          | Free bot token                                                |
| WordPress | `status=hold`       | Trash (reversible) or force delete | None in core                            | Approve, hold, spam, trash    | Application password; polling only                            |
| GitHub    | `minimizeComment`   | Yes                                | Block user from the organisation        | None                          | Free; webhooks                                                |
| Twitch    | None                | Yes, within 6 hours                | Ban, timeout up to 14 days              | Approve or deny AutoMod holds | Free; needs a moderator account                               |
| Kick      | None                | Yes                                | Ban, timeout                            | None                          | Free; young API, limits unpublished                           |
| Mastodon  | Silence an account  | Not for single posts               | Suspend, silence (instance admins only) | Reports                       | Only useful if you run the instance                           |
| Lemmy     | Remove (reversible) | Purge (admins)                     | Community ban with expiry               | Reports                       | Free; polling; official client is AGPL, so call HTTP directly |
| Matrix    | None                | Redact (permanent)                 | Kick, ban                               | Reports                       | Free; needs a bot with moderator power level                  |
| Discourse | Via flags only      | Soft delete                        | Suspend, silence                        | Review queue                  | Free self-hosted; hosted API needs a paid plan                |
| Disqus    | None                | Remove and restore                 | Ban with expiry, shadow ban             | Approve, spam                 | Free plan with ads; 1,000 requests/hour                       |
| Slack     | None                | Only with an admin user token      | Kick; ban needs paid plans              | None                          | Limited                                                       |
| Zulip     | None                | Yes                                | Deactivate user                         | Report                        | Free for volunteer-run nonprofits                             |

No moderation possible through an API: Substack (no API), Google Business Profile reviews (reply only), Pinterest, Snapchat.

Chat platforms have short action windows (Twitch 6 hours, Telegram 48 hours). Connectors declare the window, and the pipeline sends a comment to a human before the window closes rather than after.

### Build order

| Wave         | Connectors                                                                           | Why this order                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1            | Generic REST and webhook, YouTube, Facebook Pages and Instagram (one Meta connector) | Your stated priorities; YouTube and Facebook have the full hide, delete and ban set                                                |
| 2            | Telegram, Discord, WordPress, Threads, GitHub, Bluesky                               | Free, no approval gate. Threads reuses the Meta app. GitHub covers the organisation's own repos                                    |
| 3            | TikTok, X, Reddit, Twitch, Disqus, Discourse, Mastodon, Matrix, Lemmy                | Gated, paid, hide-only, or only relevant to installers who run those communities                                                   |
| Parked       | LinkedIn                                                                             | Access is restricted to commercial use, and deleting other members' comments is unproven. Test with a real account before building |
| Not possible | Pinterest, Snapchat, Substack, Google Business Profile reviews                       | No moderation API                                                                                                                  |

Every connector after wave 1 is built against the same contract test suite, so adding one does not touch the pipeline.

### Prior art

No maintained open-source project unifies moderation actions across several platforms behind one interface; that is the gap this repo fills. Worth knowing:

- `roostorg/coop` (Apache-2.0, TypeScript): a platform-agnostic review console with queues, rules and strikes. It is the alternative to building our own dashboard. I recommend our own: you asked for a very light one, the analytics you want are specific to the two-stage pipeline, and Coop's footprint beside a local LLM on 16 GB is unverified. The generic REST and callback contract keeps the door open to plugging Coop in later.
- `umputun/tg-spam` (MIT, Go): Telegram spam bot with LLM checks, including Jev. Reference for the Telegram connector.
- `discourse/discourse-mcp` (MIT): official; reference for exposing moderation actions as MCP tools with writes opt-in.

## Stack and repo layout

| Concern            | Pick                                                                              | Reason                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node 24, strict TypeScript                                                        | Current LTS                                                                                                     |
| HTTP and dashboard | Hono with server-rendered JSX and htmx                                            | Typed routes, OpenAPI from Zod and HTML rendering in one dependency; no bundler                                 |
| Database access    | Kysely with generated types, hand-written SQL migrations                          | The schema relies on views, partial unique indexes and insert-only triggers                                     |
| Job queue          | Graphile Worker (on Postgres)                                                     | Jobs are enqueued inside the same transaction as the state change; serial queues suit stage 2; no extra service |
| Auth               | Own minimal: argon2id passwords, hashed session cookies, hashed scoped API tokens | No third-party login needed; first admin is created by CLI                                                      |
| Tests              | Vitest, real Postgres via Testcontainers, a fake-platform connector               | Pipeline correctness depends on real transactions                                                               |

```
kommentarwache/
  packages/contract/   Zod schemas, command registry
  packages/server/     pipeline, providers, policy, connectors, actions, api, dashboard, cli, migrations
  packages/mcp/        stdio shim over REST
  skills/              four SKILL.md folders
  .claude-plugin/  .mcp.json  plugin.json  mcp.json  AGENTS.md
  training/            Python: fine-tune notebook, calibration, laya-serve Dockerfile
  eval/sets/           synthetic-24.jsonl
  docs/                connectors, privacy notes, opencode example
  docker-compose.yml   postgres, server; optional profiles: llm (Ollama), laya
  LICENSE  README.md  README.de.md  .env.example
```

Hono instead of the report's Fastify is my pick, for the built-in server rendering; say so if you prefer Fastify.

## What gets reused from the test build

| From `/home/tim/Desktop/Typesafe/ContentModeration/`                  | Becomes                                                                           |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `policy.py` (`Policy`, `route`, reasons)                              | Mapper and policy in `packages/server/src/policy/`                                |
| `questions.py`                                                        | Battery v1; basis for battery v2                                                  |
| `tests/test_policy.py`                                                | Vitest port                                                                       |
| `comments.jsonl` (24 synthetic comments with expected verdicts)       | `eval/sets/synthetic-24.jsonl`                                                    |
| `moderate.py --reroute`                                               | Policy replay                                                                     |
| `data/counsel/brief_codex.md` policy wording                          | Seed for the stage-2 policy prompt                                                |
| `data/fb_reel_*` (357 real comments, 118 with second-reviewer labels) | NOT committed: real people's comments. Used only as a local, git-ignored eval set |

## Milestones

Each ends in something runnable.

| #   | Delivers                                                                                                                                 | Verified by                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Repo scaffold, licence, CI, compose with Postgres, migrations, policy port, import of the prototype's stored results                     | Ported tests pass; the router reproduces the prototype's counts (23 of 24 on the synthetic set; 206 / 113 / 38 on the local Facebook set)                                                                                              |
| 1   | Stage 1 live with Jev, battery v2, `POST /v1/moderate`, JSONL import, eval harness                                                       | Battery v2 is no worse than v1 on both labelled sets; a double POST yields one row; killing the worker mid-run loses and duplicates nothing                                                                                            |
| 2   | Stage 2 via Ollama, queue worker, deadlines                                                                                              | Measured latency on the real server; with stage 2 slowed to 60 s, a 500-comment burst is all closed or queued by its deadline; report how much of the unsure band stage 2 resolves and how often it matches the second-reviewer labels |
| 3   | Dashboard and accounts: queue, comment detail, log, analytics                                                                            | Browser walk-through: sign in, open a queued comment's link, decide, see the log entry and the analytics change                                                                                                                        |
| 4   | Actions engine on a fake platform: ladder, modes, caps, undo, strikes                                                                    | Dry run makes zero platform calls; a replayed job does not act twice; the hourly cap trips                                                                                                                                             |
| 5   | Wave-1 connectors in dry run on the Verein's own accounts                                                                                | A test comment appears, its link opens on the platform, hide and unhide round-trip; dry-run precision report                                                                                                                           |
| 6   | MCP server, skills, both plugin manifests, `AGENTS.md`                                                                                   | Install from the local path in Claude Code; resolve a queue item through MCP and see it logged as an agent action; the parity test passes                                                                                              |
| 7   | Laya workflow: shadow providers, export, notebook, calibration, gates, promote and rollback. Llama Guard and OpenAI moderation providers | Exported JSONL is accepted by Laya's trainer on a small sample; shadow assessments appear in the dashboard; a timed rollback drill                                                                                                     |
| 8   | Further connectors against a shared contract test suite; OAuth for ChatGPT and Cowork                                                    | Per connector: the contract suite passes in dry run                                                                                                                                                                                    |

Start early because they take weeks: Google OAuth verification for YouTube, and a data-processing check for sending comment text to Jev.

Publishing: the repo stays local until you say otherwise. Creating it under the KI-Klub-Werder-e-V organisation and pushing is a separate step that needs your go-ahead; this session has no access to that organisation.

## End-to-end verification

1. `docker compose up`, run migrations, create the first admin by CLI.
2. `kw import eval/sets/synthetic-24.jsonl` and check the verdict table against the expected column.
3. POST an obvious violation, an obvious ok and a borderline comment to `/v1/moderate` with the fake-platform source in `auto`: the first is hidden, the second closed, the third appears in the dashboard queue after stage 2.
4. Decide the queued comment in the browser; confirm the action row, the audit log entry and the analytics counters.
5. Repeat step 4 through the MCP tool from Claude Code; confirm it is logged as an agent action.
6. `pnpm test` (unit, pipeline with real Postgres, command parity) and `pnpm eval` (agreement on the labelled sets).

## Risks and open defaults

Risks, most serious first:

1. Both models share blind spots (quoted slurs, irony, criticism of public figures), so agreement is not proof. Deleting legitimate political criticism is the worst outcome for a Verein. Mitigation: the delete category list, thread context for stage 2, hourly caps, the audit sample.
2. No ground truth for your audience: our real data is one English US thread. Mitigation: the dry-run period per source and precision reported with its uncertainty.
3. The human queue collects every failure (timeouts, disagreements, audits). The prototype already sent 32% to review. Mitigation: share-read by reason on the front page of the analytics.
4. A CPU-sized stage-2 model may be weaker than Jev on German nuance. Mitigation: milestone 2 measures it; a stronger endpoint is a config change.
5. Laya training data becomes unusable if the battery changes. Mitigation: versioned battery; comment text and human labels are the asset to keep (relabelling with Jev is cheap).
6. Data protection: third parties' comments, some political, are stored and sent to Jev. Mitigation: no author data to providers, a retention job that redacts unlabelled text (default 180 days), a privacy note in `docs/`. This needs a legal check before production use.

Defaults I chose that you may want to change:

- Mild rudeness that stage 2 confirms as merely rude is approved without a human. The prototype sent it to review.
- Three confirmed violations in 30 days trigger a ban.
- Hono rather than Fastify.
- Two-week dry run recommended per source before `auto`.
- Our own light dashboard rather than building on `roostorg/coop`.

Not verified, to be checked when the relevant milestone starts:

- The Laya repo itself. This session could not open it on GitHub; the Laya facts here come from its Hugging Face card, PyPI page and third-party write-ups.
- Laya's memory use and speed on the real server, and stage-2 speed. Both are estimates.
- Whether Shieldstral runs in stock Ollama (only community builds exist).
- Whether Meta accepts a German Verein for business verification (only needed for Instagram and Threads webhooks).
