---
name: review-queue
description: Work through kommentarwache's human review queue with the MCP tools; use when asked to review flagged comments, clear the moderation queue, or decide what to do with a comment the models left unsure.
---

# Working the review queue

The queue holds only what two models could not settle: both stages unsure, a stage-1
flag the second stage disputed, a proposed delete or ban, or a failed action. Each item
links to the comment on its platform.

## Loop

1. `list_queue` (start with `limit: 20`). Items carry the stage-1 and stage-2 verdicts,
   the reason they are here and the judge's one-sentence rationale.
2. For each item, `get_comment` to read the text, the thread context and the
   probabilities behind each verdict.
3. Decide with `decide_comment`:
   - `verdict: "ok"` when no person or group is attacked, including blunt criticism of
     ideas, products or public figures, grief, sarcasm, and quoting abuse to object to it.
   - `verdict: "violation"` with a category (`rude`, `harassment`, `hate`, `threat`,
     `doxxing`, `spam`, `scam`) when the text itself crosses the line.
     Add a short `note` when the call was close. A decision resolves the queue item and
     lets the ladder act (hide, or undo a hide).
4. For a `proposed_action` item, read the proposal in `get_comment` and either execute
   it with `act_on_comment` (`op: "execute:<actionId>"`) or decide the comment `ok`.

## Rules

- You act under your token's scopes. Delete and ban need the `actions` scope; without it
  they become proposals, which is the intended default for agents.
- Never delete or ban on your own judgment alone when the two stages disagreed: say why
  in the note and leave the irreversible step to a person.
- Judge the comment text, not the politics or identity of its author. Comments may be in
  German or another language.
- Do not re-decide a comment that is already `closed` unless asked.
- At the end, report counts: decided ok, decided violation by category, left for a
  person, and anything odd (repeated authors, a platform that failed to act).
