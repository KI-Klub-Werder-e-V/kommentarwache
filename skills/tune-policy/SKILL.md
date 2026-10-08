---
name: tune-policy
description: Analyse how kommentarwache's thresholds and stage-2 policy perform and propose changes; use when asked why so much reaches the human queue, whether to raise or lower a threshold, or to compare policies on stored answers before changing anything.
---

# Tuning the policy

Thresholds live in a versioned policy, and every assessment keeps its raw probabilities,
so a candidate policy can be replayed over history without calling a model. Change the
numbers from evidence, not from a single comment.

## Read the evidence

1. `get_analytics` for 7 and 30 days: the share of comments a human had to read, how
   often stage 2 changed stage 1's verdict (and in which direction), and human overrides.
2. `list_log` with `stage: "human"` to read what people overturned and their notes.
   Many `violation -> ok` overrides at one category point at a threshold or a stage-2
   wording problem; many `ok -> violation` at a blind spot.
3. `get_policy` for the current thresholds, the stage-2 wording and examples, and the
   ladder's delete and ban lists.

## Compare before changing

`replay_policy` with `source` set to a connector that has labels (an eval connector, or a
source with enough human decisions) and `policy` set to a named policy
(`severity_led`, `strict`, `permissive`, `naive`). It reports verdict counts and
agreement with the labels; `kw replay --misses` on the CLI lists the disagreements.

A good change moves agreement up or the human share down without moving the other the
wrong way. Report both numbers before and after.

## Propose, do not apply

Policies are immutable versions activated with `kw setup`; the code's named policies are
in `packages/server/src/policy/policy.ts` and the stage-2 wording in
`packages/server/src/policy/stage2.ts`. Propose the exact edit (threshold, example or
wording) with the replay numbers that justify it, and let a person activate it. Never
weaken the ladder (delete and ban lists, strike count) in the same change as a threshold.
