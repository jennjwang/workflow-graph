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
    onet_occupations.json      O*NET catalog for the occupation screener
    pairs.json                 same-activity matched groups (win rate)
  lib/        io.mjs · stats.mjs        (loaders; Wilson + t-interval, no bootstrap)
  coverage.mjs               coverage scoring
  winrate.mjs                win-rate scoring
  out/                       assignments / responses / verifications (git-ignored)

src/components/validation/   front-end study screens (separate from the interview app)
  CoverageStudy · WinRateStudy · OccupationScreener · TimeAllocation
  CoverageTaskCards · PairwiseJudgment · validationUi
src/lib/validation/          coverageApi · winrateApi · screenerApi
server.js                    /api/validation/* endpoints (verify, coverage/*, winrate/*)
```

The study screens mount standalone via `?study=coverage` / `?study=winrate`
(`src/main.tsx`), bypassing the interview phase machine entirely.

## Data lineage (adapter)

`inputs/` is regenerated from the pipeline's authoritative outputs — never hand-edited:

```bash
python3 validation/adapters/build_inputs.py --ta ~/PhD/task_aggregation
```

| input | source in task_aggregation |
|---|---|
| ours statements | **`resolved_tasks.json` — the 32 resolved structural nodes** (`tasks[].statement`, the canonical taxonomy) |
| onet statements | `data/onet_swe_tasks.csv` rows for 15-1252.00 (17 tasks) |
| matched pairs | `…/alignment/onet_resolved_5way.json` — **5-way classifier `equivalence`** edges only |

> Earlier inputs rode on the **orphaned crosswalk-29** (a stale alignment-era clustering whose
> statements overlap 0/29 with both this taxonomy and the old step5). Now `ours` is the canonical
> **32 resolved nodes**, and the 5-way matching is re-run against *those* clusters
> (`onet_resolved_5way.json`).

**The matcher is the pipeline's 5-way relationship classifier** (`final/relationships`,
the same function the aggregation pipeline uses), where `equivalence` = *same task,
different wording*. We deliberately do **not** use the coverage-alignment's
`equivalent` label — that is mutual work-*coverage* entailment ("doing A carries out
B"), a different, noisier criterion. Granularity edges (`instantiation` / `composition`
/ `overlap`) are excluded from win-rate pairs. Pairs are bipartite components — 1-to-N
fans kept as a group; many-to-many dropped.

> **Win rate is not viable for Software Developer.** The 5-way classifier finds
> **zero** `equivalence` pairs between the **32 resolved nodes** and O*NET's 17 tasks
> (only `instantiation`/`overlap` — ours decomposes O*NET's coarse statements; the
> relation is granularity, not sameness), so `pairs.json` is empty. That 0-equivalence
> result is itself a finding, and it holds on the canonical clusters, not just the
> stale crosswalk set. The coverage-alignment
> (`score_alignment.py`) is kept only as an auxiliary O*NET-coverage / novelty signal,
> never as the win-rate matcher.

## Metrics

| metric | status | run |
|---|---|---|
| **Coverage** — share of weekly work time on the inventory | ✅ built | `node validation/coverage.mjs` |
| **Win rate** — ours vs onet on matched pairs | ⚠️ built; **no pairs for SWE** (0 equivalence) | `node validation/winrate.mjs` |
| Quality / precision — relevance of new tasks | later | — |
| Quality / rubric — analyst standard (LLM judge) | later | — |

CIs: Wilson for proportions (win rate / precision / rubric), t-interval for
coverage. No bootstrap.

Every study gates on a shared **occupation screener** (`/api/validation/verify`):
the participant describes their job; an LLM classifies it into one O*NET occupation
against a catalog and passes only if it equals the target. Classification weighs
the described duties over the self-reported title; the target is never revealed.

## Fielding

```
…/?study=coverage&PROLIFIC_PID=<id>     # coverage allocation
…/?study=winrate&PROLIFIC_PID=<id>      # matched-pair preference
```
Each participant needs a unique id (assignment is sticky per id). Responses land
in `out/` — **ephemeral on Cloud Run**; point it at a persisted volume before
fielding at scale.
