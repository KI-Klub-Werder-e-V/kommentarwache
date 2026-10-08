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

## Stage 2 on the Facebook set (gemma4:12b through Ollama, 2026-10-08)

`kw stage2-run` pushed the 103 comments stage 1 did not close (62 unsure, 41
violations) through the text LLM on a 16-core workstation CPU.

| | count |
| --- | ---: |
| judged | 103 |
| closed by stage 2 | 71 (unsure→ok 33, unsure→violation 12, violation confirmed 26) |
| sent to a human | 32 (both unsure 17, stage 1 flag disputed by stage 2 15) |
| median / p95 latency per comment | 19.7 s / 25.0 s |

Against the 118 blind labels: stage-1 verdicts agreed on 90 of 118; the final verdicts
of the 100 labelled comments that are closed agreed on 71. Where the judge differed from
the labels it was mostly lenient: of the 12 labelled comments it moved from unsure to
ok, the reviewer had called 7 "review"; of the 25 labelled violations it confirmed, the
reviewer had called 9 less than a violation. The 10 labelled stage-1 flags it disputed
went to a human, and 7 of those the reviewer agreed were violations, which is what the
"disputed flags go to a person" rule is for.

What this means for the design: with stage 2, 31 of 357 comments (9 percent) reach a
human, against 32 percent in the prototype, at the cost of a judge that is somewhat more
permissive on mild rudeness than the blind reviewer. The stage-2 confidence lines and
wording in `packages/server/src/policy/stage2.ts` are the knobs; `kw replay` does not
cover stage 2 yet, so changing them means re-running `kw stage2-run` on a fresh connector.
