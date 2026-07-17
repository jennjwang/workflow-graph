#!/usr/bin/env python3
"""Simulated incumbents for the held-out coverage study — faithful to the real instrument.

The instrument SHOWS the participant a method's task statements; for each, they decide whether they perform it
and how many weekly hours (0 = don't do it); time no statement captures goes to a single "Other" bucket.
coveredShare = inventory-hours / total. We simulate exactly that self-report: each persona first has a hidden
TRUE weekly profile generated blind to any inventory (so the underlying work is the same across methods and
neither `ours` nor `onet` is favored), then — shown a method's statements — the persona fills in per-statement
hours from that real week and dumps the uncaptured remainder into Other. The same worker rates BOTH methods,
so the ours-vs-onet comparison is paired.

Personas + true profiles are CACHED (validation/out/sim_profiles.json). Swap new statements into
inventories.json and re-run: the same workers are re-scored, only the coverage judgment re-runs.

Writes one response per (worker, method) to validation/out/responses/coverage/sim-<i>-<method>.json (+ a
matching assignment stub), so `node validation/coverage.mjs` then aggregates it.

  python validation/sim_workers.py [N]          # N = number of simulated workers (default 12)
  FORCE_PROFILES=1 python validation/sim_workers.py   # regenerate personas/profiles from scratch
"""
import os, sys, json, re
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
INV = Path(os.environ.get("SIM_INVENTORIES") or (HERE / "inputs" / "inventories.json"))
RESP_DIR = HERE / "out" / "responses" / "coverage"
ASSIGN_DIR = HERE / "out" / "assignments" / "coverage"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
TOTAL_HOURS = 40
MODEL = "gpt-5-mini"


def _env():
    e = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1); e[k] = v.strip().strip('"').strip("'")
    return e


ENV = _env()
from openai import OpenAI
CLIENT = OpenAI(api_key=ENV["OPENAI_API_KEY"], **({"base_url": ENV["OPENAI_BASE_URL"]} if ENV.get("OPENAI_BASE_URL") else {}))


def chat_json(system, user, temperature=None):
    kwargs = {"model": MODEL, "response_format": {"type": "json_object"},
              "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    for extra in ([{"temperature": temperature}] if temperature is not None else []) + [{}]:
        try:
            r = CLIENT.chat.completions.create(**kwargs, **extra)
            return json.loads(r.choices[0].message.content or "{}")
        except Exception:
            continue
    return {}


def gen_personas(occupation, n):
    sys_p = (f"You are designing a diverse, realistic panel of {n} people who all work as a {occupation}. "
             "Vary their specialization, seniority, company size/type, and how much they use AI tools. Each is a "
             "one-sentence description of a REAL working person, not a stereotype. "
             'Respond ONLY JSON: {"workers":["<desc>", ...]} with exactly '
             f"{n} entries.")
    out = chat_json(sys_p, f"Design the {n}-person panel of {occupation}s.", temperature=0.7).get("workers", [])
    out = [w for w in out if isinstance(w, str) and w.strip()]
    return (out + [f"a typical {occupation}"] * n)[:n]


def gen_profile(occupation, who):
    sys_p = (f"You are {who} — a {occupation}. Recall a REPRESENTATIVE recent work week and list how you actually "
             f"spent your ~{TOTAL_HOURS} working hours, as concrete tasks (verb + object). Include everything real: "
             "core work, meetings, code review, planning, debugging, learning, admin, interruptions. Do NOT think "
             "about any predefined task list — just report your real week. Hours should sum to about "
             f"{TOTAL_HOURS}. "
             'Respond ONLY JSON: {"tasks":[{"task":"<what you did>","hours":<number>}, ...]}.')
    js = chat_json(sys_p, "List your week's tasks and hours.", temperature=0.6).get("tasks", [])
    prof = [(str(t.get("task", "")).strip(), float(t.get("hours", 0) or 0)) for t in js if str(t.get("task", "")).strip()]
    s = sum(h for _, h in prof) or 1.0
    return [(t, round(h * TOTAL_HOURS / s, 2)) for t, h in prof]   # renormalize to TOTAL_HOURS


def allocate(occupation, who, profile, statements):
    """Faithful to the real instrument: the participant is SHOWN the statements and decides, for each, whether
    they perform it and how many weekly hours (0 = don't do it); time no statement captures goes to a single
    Other bucket. Their hidden real week is given only as self-reference for coherent rating. Returns
    (total_hours, {statement_idx: hours}, other_hours)."""
    numbered = "\n".join(f"{i}: {s}" for i, s in enumerate(statements))
    week = "; ".join(f"{t} (~{h}h)" for t, h in profile)
    sys_p = (f"You are {who} — a {occupation}. For your own reference, your typical work week looks like: {week}.\n\n"
             "You are now shown a list of task statements. For EACH statement, decide whether YOU actually perform "
             "that task in a typical week, and if so how many hours/week you spend on it (omit it, or 0, if you do "
             "not do it). Only count a statement when your real work genuinely IS that task or part of it — do NOT "
             "inflate or stretch to fit. Then put ALL remaining weekly hours that these statements do NOT capture "
             "into a single 'other' number. Your per-statement hours plus other should total your weekly hours "
             f"(about {TOTAL_HOURS}). "
             'Respond ONLY JSON: {"total_hours":<num>,"statement_hours":{"<id>":<hours>, ...only ones you do...},'
             '"other_hours":<num>}.')
    j = chat_json(sys_p, f"TASK STATEMENTS:\n{numbered}")
    sh = {}
    for k, v in (j.get("statement_hours") or {}).items():
        try:
            i, h = int(k), float(v)
        except (ValueError, TypeError):
            continue
        if 0 <= i < len(statements) and h > 0:
            sh[i] = h
    other = float(j.get("other_hours") or 0)
    total = float(j.get("total_hours") or 0) or (sum(sh.values()) + other)
    if not other:
        other = max(0.0, total - sum(sh.values()))
    return round(total, 2), sh, round(other, 2)


def ask_one(occupation, who, week, statement):
    """One statement at a time: shown ONLY this statement (no list), the participant says whether they do it and
    how many weekly hours. Independent of every other statement — no 40h budget, no cross-statement comparison."""
    sys_p = (f"You are {who} — a {occupation}. For your own reference, your typical work week looks like: {week}.\n\n"
             "You are shown ONE task statement. Decide whether YOU actually perform this task in a typical week, and "
             "if so how many hours/week you spend on it. Answer 0 if you do not do it, or if your real work is not "
             "genuinely this task. Do NOT inflate or stretch to fit. "
             'Respond ONLY JSON: {"hours":<num>}.')
    j = chat_json(sys_p, f"TASK STATEMENT:\n{statement}")
    try:
        return max(0.0, float(j.get("hours", 0) or 0))
    except (TypeError, ValueError):
        return 0.0


def main():
    inv = json.loads(INV.read_text())
    occupation = inv.get("occupation", "worker")
    code = str(inv.get("onetCode", "x")).replace(".", "_")   # per-occupation cache + id namespace
    methods = inv["methods"]
    PROFILE_CACHE = HERE / "out" / f"sim_profiles_{code}.json"
    RESP_DIR.mkdir(parents=True, exist_ok=True); ASSIGN_DIR.mkdir(parents=True, exist_ok=True)

    # personas + true profiles (cached — independent of the inventories)
    if PROFILE_CACHE.exists() and not os.environ.get("FORCE_PROFILES"):
        cache = json.loads(PROFILE_CACHE.read_text())
        personas, profiles = cache["personas"], [[(t, h) for t, h in p] for p in cache["profiles"]]
        print(f"reusing {len(personas)} cached personas/profiles (FORCE_PROFILES=1 to regenerate)")
    else:
        print(f"generating {N} personas for '{occupation}'...", flush=True)
        personas = gen_personas(occupation, N)
        with ThreadPoolExecutor(max_workers=8) as ex:
            profiles = list(ex.map(lambda w: gen_profile(occupation, w), personas))
        PROFILE_CACHE.write_text(json.dumps({"personas": personas, "profiles": profiles}, indent=2))
        print(f"  wrote {PROFILE_CACHE.name}")

    # coverage judgment per (worker, method) — depends on the current statements
    msum = ", ".join(f"{k}:{len(v['statements'])}" for k, v in methods.items())
    print(f"judging coverage of {len(personas)} workers vs {len(methods)} methods ({msum})...", flush=True)
    rows = {m: [] for m in methods}
    weeks = {wi: "; ".join(f"{t} (~{h}h)" for t, h in prof) for wi, (who, prof) in enumerate(zip(personas, profiles))}
    one_at_a_time = bool(os.environ.get("ONE_AT_A_TIME"))
    prefix = "sim1" if one_at_a_time else "sim"

    if one_at_a_time:
        # per-statement independent elicitation: one call per (worker, method, statement); no 40h budget
        print("  mode: ONE STATEMENT AT A TIME (independent, no budget)", flush=True)
        stmt_jobs = [(wi, who, prof, method, mv["statements"], si, s)
                     for wi, (who, prof) in enumerate(zip(personas, profiles))
                     for method, mv in methods.items()
                     for si, s in enumerate(mv["statements"])]
        with ThreadPoolExecutor(max_workers=16) as ex:
            asked = list(ex.map(lambda j: (j[0], j[3], j[5], ask_one(occupation, j[1], weeks[j[0]], j[6])), stmt_jobs))
        agg = defaultdict(dict)
        for wi, method, si, h in asked:
            if h > 0:
                agg[(wi, method)][si] = h
        results = []
        for wi, (who, prof) in enumerate(zip(personas, profiles)):
            for method, mv in methods.items():
                sh = agg[(wi, method)]
                total = float(TOTAL_HOURS)                    # stated week; per-statement hours may sum past it
                results.append(((wi, who, prof, method, mv["statements"]), total, sh,
                                round(max(0.0, total - sum(sh.values())), 2)))
    else:
        # all statements shown together — one allocation call per (worker, method), budgeted to ~40h
        jobs = [(wi, who, prof, method, mv["statements"])
                for wi, (who, prof) in enumerate(zip(personas, profiles))
                for method, mv in methods.items()]

        def run(job):
            wi, who, prof, method, statements = job
            return (job, *allocate(occupation, who, prof, statements))

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(run, jobs))

    for (wi, who, prof, method, statements), total, sh, other in results:
        allocations = [{"name": statements[i], "hours": round(h, 2), "source": "inventory"}
                       for i, h in sorted(sh.items())]
        allocations.append({"name": "Other — work these tasks don't capture",
                            "hours": other, "source": "other"})
        covered = round(sum(h for h in sh.values()), 2)
        share = min(1.0, covered / total) if total > 0 else None
        rows[method].append((share, covered / total if total else 0))   # (capped share, raw ratio)
        rid = f"{prefix}-{code}-{wi:02d}-{method}"
        (ASSIGN_DIR / f"{rid}.json").write_text(json.dumps(
            {"externalId": rid, "method": method, "occupation": occupation, "assignedAt": "sim"}, indent=2))
        (RESP_DIR / f"{rid}.json").write_text(json.dumps({
            "externalId": rid, "method": method, "occupation": occupation,
            "selfIdOccupation": {"selectedTitle": occupation, "sim": True, "persona": who},
            "totalHours": total, "allocations": allocations,
            "coveredHours": covered, "otherHours": other,
            "uncoveredHours": round(max(0.0, total - covered), 2),
            "coveredShare": share, "elapsedMs": None, "startedAt": "sim", "submittedAt": "sim",
        }, indent=2))

    print(f"\nwrote {sum(len(v) for v in rows.values())} sim responses to {RESP_DIR}"
          + ("   [ONE-AT-A-TIME mode]\n" if one_at_a_time else "\n"))
    print(f"  {'method':10} {'n':>3} {'covered-share':>14} {'raw sum/total':>14}")
    for m, vals in rows.items():
        cs = [s for s, _ in vals if s is not None]
        raw = [r for _, r in vals]
        mean = sum(cs) / len(cs) if cs else 0
        rawmean = sum(raw) / len(raw) if raw else 0
        # raw>1 means per-statement hours summed PAST the real week — overlap/double-count the budget would hide
        flag = "  <- overlaps past 100%" if rawmean > 1.02 else ""
        print(f"  {m:10} {len(cs):>3} {mean:>13.1%} {rawmean:>13.0%}{flag}")
    print(f"\nnow run:  node validation/coverage.mjs")


if __name__ == "__main__":
    main()
