# Using kommentarwache from a coding agent

Everything a moderator can do in the dashboard, an agent can do through the same
commands, under a token with the same scopes, and every call is logged under that token.
The commands are one catalogue (`packages/contract/src/commands.ts`); the REST routes
and the MCP tools are generated from it, and a test keeps them in step.

| Tool                                                                       | Scope              | Does                                                                                           |
| -------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `moderate_comment`                                                         | moderate           | submit one comment, get the stage-1 verdict                                                    |
| `list_queue`, `get_comment`                                                | review             | read the review queue and a comment's timeline                                                 |
| `decide_comment`                                                           | review             | ok or violation; resolves the queue item, hide or unhide follows                               |
| `act_on_comment`                                                           | review (+ actions) | hide, delete, ban, execute a proposal, undo; delete and ban need `actions` or become proposals |
| `list_log`, `get_analytics`, `get_policy`, `replay_policy`, `list_sources` | review             | read                                                                                           |
| `set_source_modes`                                                         | admin              | how far a source may act on its own                                                            |

Create a token: `kw token create --name <agent> --scopes moderate,review`. Add `actions`
only for an agent that may delete and ban, and `admin` only for setup work.

## Two ways in

- **HTTP MCP** at `https://<server>/mcp` with `Authorization: Bearer <token>`. Stateless,
  so it works behind any proxy. This is what the Claude Code plugin uses.
- **stdio** through `npx -y kommentarwache-mcp --stdio` with `KW_URL` and `KW_TOKEN` in
  the environment. It calls the REST API, so it needs no database access. This is what
  Codex and opencode use locally.

## Claude Code and Cowork

```bash
claude plugin marketplace add KI-Klub-Werder-e-V/kommentarwache
claude plugin install kommentarwache@kommentarwache
```

Claude Code asks for the server URL and token (`userConfig` in `.claude-plugin/plugin.json`)
and wires `.mcp.json` to `/mcp`. The three skills (`kommentarwache-setup`,
`review-queue`, `tune-policy`) arrive with the plugin as `/kommentarwache:<skill>`.
Cowork loads the skills but cannot prompt for a per-install URL, so add the server as a
custom connector by hand there.

## Codex and ChatGPT

The root `plugin.json` and `mcp.json` follow Agent Plugins 1.0:
`codex plugin marketplace add KI-Klub-Werder-e-V/kommentarwache`, then set `KW_URL` and
`KW_TOKEN` in the environment. Skills are read from `skills/`. ChatGPT needs the HTTP
endpoint on a public HTTPS URL; OAuth for it is milestone 8.

## opencode

Copy `docs/opencode.json.example` into your `opencode.json` (remote MCP with the bearer
header), or use the stdio form with `"type": "local"`. opencode reads `.claude/skills`
and `.agents/skills`, so symlink or copy `skills/` there.

## Verifying a signed callback (generic sites)

Sites that receive actions from the `api` source verify `X-KW-Signature`
(`sha256=` + hex HMAC-SHA256 of the raw body with the shared `callback_secret`) before
applying anything. See `docs/connectors.md`.
