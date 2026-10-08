# Evaluation sets and results

`kw eval` runs a labelled JSONL set through stage 1 live and stores every answer under an
eval connector, so `kw replay` can re-route the same answers under another policy without
calling a model. Use a fresh connector name per battery version: stage 1 is idempotent per
comment, so a second run on the same connector reuses the stored decisions.

```bash
kw eval --set eval/sets/synthetic-24.jsonl --connector eval-v2-synthetic --battery v2
kw labels import --connector eval-v2-fb --file eval/local/fb-reel/codex_labels.json --source codex
kw replay --connector eval-v2-fb --policy strict --misses
```

## Sets

| Set | Where | What |
| --- | --- | --- |
| `sets/synthetic-24.jsonl` | in the repo | 24 written comments (English and German) with an `expected` verdict: praise, blunt reviews, grief, a quoted slur, spam, mild rudeness, insults, a group attack, a threat, two adversarial comments |
| `sets/synthetic-24.results.jsonl` | in the repo | Jev's answers to those 24 under the prototype's battery v1; the parity fixture for `kw import-prototype` |
| `local/fb-reel/` | git-ignored | 357 public comments from one Facebook Reel, 118 of them labelled blind by a second reviewer (Codex). Real people's comments, so never committed |

`expected` uses the prototype's words `approve / review / flag`; `ok / unsure / violation`
are accepted too. Spam was out of scope for the prototype; since battery v2 it is a
violation, and the synthetic set's label was changed to match.

## Results (Jev `jev-1.13.0`, policy `severity_led`)

| Set | Battery | ok / unsure / violation | Agreement with labels | Cost |
| --- | --- | ---: | ---: | ---: |
| synthetic-24 | v1, prototype's stored answers (2026-10-03) | 14 / 5 / 5 | 23 of 24 | |
| synthetic-24 | v1, live 2026-10-08 | 14 / 4 / 6 | 24 of 24 | $0.0009 |
| synthetic-24 | v2 version 1 | 12 / 5 / 7 | 22 of 24 | $0.0011 |
| synthetic-24 | v2 version 2 | 13 / 4 / 7 | 24 of 24 | $0.0012 |
| fb-reel (357) | v1, prototype's stored answers | 206 / 113 / 38 | 86 of 118 | |
| fb-reel (357) | v2 version 1 | 254 / 64 / 39 | 92 of 118 | $0.018 |
| fb-reel (357) | v2 version 2 | 254 / 62 / 41 | 90 of 118 | $0.018 |

Policies replayed on the fb-reel v2 answers: `strict` 79 of 118, `permissive` 79 of 118,
`severity_led` 92 of 118.

What changed from v1 to v2 on the Facebook set: the unsure band fell from 113 to about 63
comments, with the number of violations unchanged, because the attack threshold moved from
0.35 to 0.60 and rude remarks aimed at the public figure in the post are tolerated. The
two v2 versions differ by a couple of comments, which is within the run-to-run variation
seen on the synthetic set (the live v1 run also moved one comment compared with the
prototype's stored answers).

Mean latency per request was 250 to 300 ms at concurrency 4 to 6.
