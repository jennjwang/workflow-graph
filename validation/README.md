# Validation

The single home for **evaluating** task inventories — kept separate from the
method itself. The `task_aggregation` pipeline (the "main task") is treated purely
as a **data source**; nothing here re-runs or depends on its internals, and the
interview app shares no runtime with it.

## Layout

```
validation/
  adapters/build_inputs.py   ← the ONLY thing that reaches into task_aggregation
  inputs/                    ← canonical, self-contained inputs (committed)
    inventories.json           ours + onet statement lists (+ onetCode)
    inventories_cs.json        CS-researcher inventory (ours + onet + llm)
    onet_occupations.json      O*NET catalog for the occupation screener
  lib/        io.mjs · stats.mjs        (loaders; Wilson + t-interval, no bootstrap)
  coverage.mjs               coverage scoring
  quality.mjs                analyst-rubric quality scoring (LLM judge)
  task_quality.mjs           interview-pipeline task-quality judge (rubric + groundedness)
  out/                       assignments / responses / verifications (git-ignored)

src/components/validation/   front-end study screens (separate from the interview app)
  CoverageStudy · OccupationScreener · TimeAllocation
  CoverageTaskCards · validationUi
src/lib/validation/          coverageApi · screenerApi
server.js                    /api/validation/* endpoints (verify, coverage/*)
```

The study screen mounts standalone via `?study=coverage`
(`src/main.tsx`), bypassing the interview phase machine entirely.

## Data lineage (adapter)

`inputs/` is regenerated from the pipeline's authoritative outputs — never hand-edited:

```bash
python3 validation/adapters/build_inputs.py --ta ~/PhD/task_aggregation
```

| input | source in task_aggregation |
|---|---|
| ours statements | **`resolved_tasks.json` — the 32 resolved structural nodes** (`tasks[].statement`, the canonical taxonomy) |
| onet statements | `…/alignment/onet_entailment_crosswalk.json` `_onet` (15 deduped O*NET tasks) |

> Earlier inputs rode on the **orphaned crosswalk-29** (a stale alignment-era clustering whose
> statements overlap 0/29 with both this taxonomy and the old step5). Now `ours` is the canonical
> **32 resolved nodes**.

## Metrics

| metric | status | run |
|---|---|---|
| **Coverage** — share of weekly work time on the inventory | ✅ built | `node validation/coverage.mjs` |
| **Quality / rubric** — analyst standard, per inventory (LLM judge) | ✅ built | `node --env-file=.env validation/quality.mjs` |
| **Task quality** — interview-pipeline tasks (rubric + groundedness) | ✅ built | `node --env-file=.env validation/task_quality.mjs` |

CIs: Wilson for proportions (rubric / quality), t-interval for coverage. No bootstrap.

Every study gates on a shared **occupation screener** (`/api/validation/verify`):
the participant describes their job; an LLM classifies it into one O*NET occupation
against a catalog and passes only if it equals the target. Classification weighs
the described duties over the self-reported title; the target is never revealed.

## Fielding

```
…/?study=coverage&PROLIFIC_PID=<id>     # coverage allocation
```
Each participant needs a unique id (assignment is sticky per id). Responses land
in `out/` — **ephemeral on Cloud Run**; point it at a persisted volume before
fielding at scale.
