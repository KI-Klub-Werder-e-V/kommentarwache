# kommentarwache

Self-hosted comment moderation for small organisations. It reads comments from the
platforms you run accounts on, classifies them with a fast decision model and a text
LLM, acts on obvious violations itself, and sends only ambiguous comments to a light
review dashboard. Every model decision is logged, and the same API is available to
coding agents through MCP.

Status: milestone 0 of 8. Not yet usable. See the plan in the pull-request history and
`docs/` as they land.

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

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Licence

Apache-2.0. See `LICENSE`.
