"""Aggregate results.json: per task x effort pass rate and cost, best effort per task, and policy simulation."""
import json, os, statistics as st, sys
B = os.path.dirname(os.path.abspath(__file__))
src = next((a for a in sys.argv[1:] if a.endswith(".json")), f"{B}/results.json")
rows = [r for r in json.load(open(src)) if r["state"] == "settled"]
E = ["low", "high", "max"]
tasks = sorted({r["task"] for r in rows})
cell = {(t, e): [r for r in rows if r["task"] == t and r["effort"] == e] for t in tasks for e in E}
def m(xs, k): return st.mean(x[k] for x in xs) if xs else float("nan")
print(f'{"task":16}' + "".join(f'{e:>26}' for e in E) + "   best")
best = {}
for t in tasks:
    line = f"{t:16}"
    stats = {}
    for e in E:
        xs = cell[(t, e)]
        if not xs: line += f'{"-":>26}'; continue
        k = sum(x["ok"] for x in xs); stats[e] = (k / len(xs), m(xs, "cost"), m(xs, "secs"))
        line += f'{k}/{len(xs)} ${m(xs,"cost"):.4f} {m(xs,"secs"):4.0f}s {m(xs,"out_tokens")/1000:4.1f}k'.rjust(26)
    if stats:
        top = max(v[0] for v in stats.values())
        cands = [e for e in E if e in stats and stats[e][0] >= top - 1e-9]
        best[t] = min(cands, key=lambda e: stats[e][1])
        line += f"   {best[t]}"
    print(line)
print()
for e in E:
    xs = [r for r in rows if r["effort"] == e]
    print(f'{e:5} pass {sum(x["ok"] for x in xs)}/{len(xs)} = {sum(x["ok"] for x in xs)/max(1,len(xs)):.1%}  mean ${m(xs,"cost"):.4f}  mean {m(xs,"secs"):.0f}s  mean out {m(xs,"out_tokens")/1000:.1f}k  total ${sum(x["cost"] for x in xs):.3f}')
# Policy simulation by rep: fixed level vs ladder low->high->max (retry only on hidden-test failure)
print()
by = {(r["task"], r["effort"], r["rep"]): r for r in rows}
pol = {"fixed low": ["low"], "fixed high": ["high"], "fixed max": ["max"], "ladder low>high>max": ["low", "high", "max"], "ladder low>max": ["low", "max"], "ladder high>max": ["high", "max"]}
for name, ladder in pol.items():
    ok = n = cost = secs = 0
    for t in tasks:
        for rep in (1, 2, 3):
            if not all((t, e, rep) in by for e in ladder): continue
            n += 1
            for e in ladder:
                r = by[(t, e, rep)]; cost += r["cost"]; secs += r["secs"]
                if r["ok"]: ok += 1; break
    if n: print(f"{name:22} success {ok}/{n} = {ok/n:.1%}  cost/task ${cost/n:.4f}  time/task {secs/n:.0f}s")
if "-v" in sys.argv:
    print()
    for r in rows:
        if not r["ok"]: print("FAIL", r["run"], r["passed"], "/", r["total"], r.get("fails"))
