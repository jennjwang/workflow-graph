#!/usr/bin/env python3
"""
Build the validation process's canonical inputs from the task_aggregation
pipeline's CURRENT taxonomy. This is the ONE place that reaches into the method
pipeline; everything else under validation/ consumes only validation/inputs/.

Run:  python3 validation/adapters/build_inputs.py [--ta /path/to/task_aggregation]

Writes:
  validation/inputs/inventories.json   ours (32 resolved nodes) + onet (15 tasks)

Sources (task_aggregation):
  results/onet_matching/resolved_tasks.json
      tasks[].statement  -> the 32 RESOLVED STRUCTURAL NODES = canonical "ours"
      (NOT the orphaned 29-cluster crosswalk, which was a stale alignment-era run
       whose statements match neither this taxonomy nor the old step5 — 0 overlap.)
  results/onet_matching/alignment/onet_entailment_crosswalk.json  (_onet: 15 deduped O*NET tasks)
"""
import argparse, json, os
from pathlib import Path

OCCUPATION = "Software Developer"
ONET_CODE = "15-1252.00"
REPO = Path(__file__).resolve().parents[1]  # validation/
INPUTS = REPO / "inputs"


def load_ours(ta: Path):
    # Keep all 32 resolved nodes. Do NOT filter on n_variants — that counts
    # distinct PHRASINGS (after exact-text dedup), not corroboration. e.g. C7
    # "Review code" is n_variants=1 but reported by 4 participants. The real
    # corroboration metric is n_participants, joined here from step2 (union over
    # any merged clusters). Every resolved node is cross_participant (>=2).
    d = json.loads((ta / "results/onet_matching/resolved_tasks.json").read_text())
    s2 = json.loads((ta / "results/onet_matching/step2_clusters.json").read_text())
    pmap = {c["id"]: set(c.get("participants") or []) for c in s2["clusters"]}
    nodes = []
    for t in d["tasks"]:
        pset = set()
        for cid in (t.get("merged_ids") or [t["id"]]):
            try:
                pset |= pmap.get(int(str(cid).lstrip("C")), set())
            except ValueError:
                pass
        nodes.append({"id": t["id"], "statement": t["statement"].strip(),
                      "nParticipants": len(pset), "nVariants": t.get("n_variants")})
    ours = {n["id"]: n["statement"] for n in nodes}
    src = "resolved_tasks.json (32 nodes; nParticipants joined from step2_clusters.json)"
    return ours, nodes, src


def load_onet(ta: Path):
    # The canonical 15 O*NET tasks (deduped/merged): the raw csv lists 17 with two
    # near-duplicate "Confer…" and two "Supervise…" rows, merged to 15 in _onet.
    p = ta / "results/onet_matching/alignment/onet_entailment_crosswalk.json"
    onet = {o["id"]: o["task"].strip() for o in json.loads(p.read_text())["_onet"]}
    return onet, f"{p.name} _onet (15 deduped O*NET tasks)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ta", default=os.path.expanduser("~/PhD/task_aggregation"))
    args = ap.parse_args()
    ta = Path(args.ta)
    if not ta.exists():
        raise SystemExit(f"task_aggregation not found at {ta} (pass --ta)")

    ours_text, ours_nodes, ours_src = load_ours(ta)
    onet_text, onet_src = load_onet(ta)

    inventories = {
        "occupation": OCCUPATION,
        "onetCode": ONET_CODE,
        "_source": {"ours": ours_src, "onet": onet_src},
        "methods": {
            "ours": {
                "label": "ours",
                "statements": list(ours_text.values()),
                "nodes": ours_nodes,  # per-node id + statement + nParticipants
            },
            "onet": {"label": "onet", "statements": list(onet_text.values())},
        },
    }
    INPUTS.mkdir(parents=True, exist_ok=True)
    (INPUTS / "inventories.json").write_text(
        json.dumps(inventories, indent=2, ensure_ascii=False) + "\n")

    print(f"inventories.json: ours={len(ours_text)} (resolved nodes) onet={len(onet_text)}")


if __name__ == "__main__":
    main()
