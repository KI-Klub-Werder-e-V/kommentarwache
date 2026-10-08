# Moving stage 1 from Jev to Laya

Laya is an open decision model (Apache-2.0, 322M parameters for the multilingual
checkpoint) that answers the same typed questions as Jev through the same
`/v1/systemone` endpoint. Its base checkpoints are near chance on our questions without
fine-tuning, so the move is a loop: collect labels under Jev, train, calibrate, gate,
shadow, promote. Everything below runs from the `kw` CLI except the training itself,
which needs a GPU for a few hours (Kaggle's free tier is enough).

## 1. Collect

Every stage-1 assessment under Jev keeps the exact state, questions and probabilities;
every human decision is a gold label. The dashboard's analytics and
`kw dataset readiness` show how many labelled cases exist per verdict class. Start
training at about 1,200 cases with at least 150 human-confirmed violations.

## 2. Export

```bash
kw dataset export --out training/exports/train.jsonl --since 2026-10-01
```

writes one line per comment in Laya's training format, `{"state", "questions", "expected"}`,
with battery v2's choice questions. `expected` carries the human verdict where one
exists (mapped onto the questions) and otherwise Jev's probability distribution as a soft
target. The export also records a split: `test` holds only human-labelled comments and is
frozen for the gate; `calib` is for temperature fitting; the rest is `train`. The export
and its items are stored in `dataset_exports` and `dataset_items`, so a gate run can name
exactly what it measured.

Comment text leaves the server only in this file. Keep it with the same care as the
database and delete it after training.

## 3. Train

Open `laya_finetune.ipynb` on Kaggle (2x T4) or any GPU machine, upload the export, run
it. It installs `laya`, fine-tunes `convaiinnovations/laya-multilingual` with
`laya-train`, fits temperatures on the `calib` split and writes a checkpoint directory.
The published fine-tune of this size took 4 to 5 hours.

Note: the JSONL shape for soft targets follows Laya's documented
`records_from_labeled` input as of October 2026 and is checked when the notebook first
runs; adjust the mapping cell if the trainer expects another key.

## 4. Serve

Copy the checkpoint to `training/checkpoints/<name>` on the server and start
`laya-serve` with the `laya` compose profile, or point `LAYA_URL` at a running one:

```bash
docker compose --profile laya up -d laya
kw laya shadow --model multilingual     # a new pipeline config with Laya as a shadow
```

## 5. Gate

```bash
kw laya gate --source eval-gold        # replays the gold set through Laya and Jev
```

The gate compares Laya with the active primary on the frozen test split: agreement with
the human labels, precision of auto-approve, recall of violations, the share sent to
stage 2, calibration error and p95 latency on this machine. Thresholds are in
`packages/server/src/laya/gate.ts`; the result is a row in `evaluations` with
`gate_passed`.

## 6. Shadow, promote, roll back

With Laya as a shadow, every stage-1 comment is also judged by Laya; disagreements that
involve a violation become `shadow_diff` items in the review queue, and the analytics
show the disagreement rate. After at least two weeks:

```bash
kw laya promote      # Laya primary, Jev shadow; delete and ban drop to propose for a week
kw laya rollback     # the previous pipeline config, in one command
```

Comment text stops leaving the server once the Jev shadow is switched off
(`kw laya promote --no-shadow` later).
