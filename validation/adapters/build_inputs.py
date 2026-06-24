#!/usr/bin/env python3
"""
Build the validation process's canonical inputs from the task_aggregation
pipeline's CURRENT taxonomy. This is the ONE place that reaches into the method
pipeline; everything else under validation/ consumes only validation/inputs/.

Run:  python3 validation/adapters/build_inputs.py [--ta /path/to/task_aggregation]

Writes:
  validation/inputs/inventories.json   ours (32 resolved nodes) + onet (17 tasks)
  validation/inputs/pairs.json         same-activity (5-way `equivalence`) groups

Sources (task_aggregation):
  results/onet_matching/resolved_tasks.json
      tasks[].statement  -> the 32 RESOLVED STRUCTURAL NODES = canonical "ours"
      (NOT the orphaned 29-cluster crosswalk, which was a stale alignment-era run
       whose statements match neither this taxonomy nor the old step5 — 0 overlap.)
  data/onet_swe_tasks.csv   (15-1252.00 rows = the 17 O*NET Software Developer tasks)
  results/onet_matching/alignment/onet_resolved_5way.json
      edges[] from the pipeline's 5-way relationship classifier (final/relationships)
      run over resolved-node x onet-task pairs; keep label == "equivalence".

THE MATCHER IS THE 5-WAY CLASSIFIER (same function the aggregation pipeline uses).
Win-rate pairs use ONLY its `equivalence` relation (same task, different wording);
the coverage-alignment's `equivalent` (mutual work-coverage entailment) is NOT used.
Granularity (instantiation/composition/overlap) is excluded. Pairs are bipartite
components (1-to-N fans kept as a group); many-to-many dropped.

If onet_resolved_5way.json is absent (matching not yet run on the resolved nodes),
pairs.json is written empty with a note — run the matching, then re-run this.
"""
import argparse, csv, json, os
from collections import defaultdict
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


def load_equiv_edges(ta: Path, onet_ids, ours_ids):
    """5-way classifier `equivalence` edges over resolved-node x onet-task pairs."""
    p = ta / "results/onet_matching/alignment/onet15_5way.json"
    if not p.exists():
        return [], "(matching not yet run on 32x15 — pairs empty)"
    data = json.loads(p.read_text())
    edges = []
    for e in data.get("edges", []):
        if e.get("label") != "equivalence":
            continue
        a, b = e.get("a"), e.get("b")
        if a in onet_ids and b in ours_ids:
            edges.append((a, b))
        elif b in onet_ids and a in ours_ids:
            edges.append((b, a))
    return edges, str(p)


def components(edges):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for o, c in edges:
        parent[find(("O", o))] = find(("C", c))
    comp = defaultdict(lambda: {"O": set(), "C": set()})
    for o, c in edges:
        r = find(("O", o))
        comp[r]["O"].add(o)
        comp[r]["C"].add(c)
    return list(comp.values())


def build_pairs(onet, ours, edges):
    groups, excluded = [], 0
    for comp in components(edges):
        O, C = sorted(comp["O"]), sorted(comp["C"])
        if len(O) > 1 and len(C) > 1:
            excluded += 1  # many-to-many — ambiguous, drop
            continue
        groups.append({
            "id": O[0] if len(O) == 1 else C[0],
            "onet": [onet[o] for o in O if o in onet],
            "ours": [ours[c] for c in C if c in ours],
        })
    groups = [g for g in groups if g["onet"] and g["ours"]]
    return groups, excluded


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ta", default=os.path.expanduser("~/PhD/task_aggregation"))
    args = ap.parse_args()
    ta = Path(args.ta)
    if not ta.exists():
        raise SystemExit(f"task_aggregation not found at {ta} (pass --ta)")

    ours_text, ours_nodes, ours_src = load_ours(ta)
    onet_text, onet_src = load_onet(ta)
    edges, rel_src = load_equiv_edges(ta, set(onet_text), set(ours_text))

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

    pairs, excluded = build_pairs(onet_text, ours_text, edges)
    pairs_doc = {
        "occupation": OCCUPATION,
        "onetCode": ONET_CODE,
        "_source": {"ours": ours_src, "matcher": rel_src},
        "_relation": "5-way classifier `equivalence` (same task, different wording); coverage-alignment + subsumption excluded",
        "_excludedManyToMany": excluded,
        "pairs": pairs,
    }
    (INPUTS / "pairs.json").write_text(
        json.dumps(pairs_doc, indent=2, ensure_ascii=False) + "\n")

    print(f"inventories.json: ours={len(ours_text)} (resolved nodes) onet={len(onet_text)}")
    print(f"pairs.json: {len(pairs)} same-activity groups, {excluded} many-to-many excluded "
          f"[matcher: {Path(rel_src).name if rel_src.startswith('/') else rel_src}]")


if __name__ == "__main__":
    main()
