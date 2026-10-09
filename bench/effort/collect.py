"""Collect per-run metrics (cost, output tokens, turns, wall time, effort seen) and hidden-test scores."""
import json, os, glob, subprocess, sys, re, time
from datetime import datetime
B = os.path.dirname(os.path.abspath(__file__))
CC = os.path.expanduser("~/.commandcode/projects")
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
rows = []
for run in sorted(os.listdir(f"{B}/runs")):
    m = re.fullmatch(r"(t\d\d-[a-z]+)-(\w+)-r(\d+)", run)
    if not m: continue
    task, effort, rep = m.groups()
    projs = [p for p in glob.glob(f"{CC}/*") if p.endswith("runs-" + run)]
    cost = out = turns = 0; efforts = set(); times = []; mtime = 0; last_text = ""
    for p in projs:
        for f in glob.glob(f"{p}/*.jsonl"):
            if f.endswith(".checkpoints.jsonl"): continue
            mtime = max(mtime, os.path.getmtime(f))
            for line in open(f, errors="replace"):
                try: o = json.loads(line)
                except Exception: continue
                if "timestamp" in o: times.append(ts(o["timestamp"]))
                msg = o.get("message") if isinstance(o.get("message"), dict) else {}
                if msg.get("role") == "assistant":
                    c = msg.get("content"); txt = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else ""
                    if txt.strip(): last_text = txt
                u = o.get("usage")
                if u:
                    cost += u.get("costUsd") or 0; out += u.get("outputTokens") or 0; turns += 1
                    if o.get("effort"): efforts.add(o["effort"])
    if not projs or not times:
        rows.append(dict(run=run, task=task, effort=effort, rep=int(rep), state="not-started")); continue
    fresh = "HEAD DONE" not in last_text and time.time() - mtime < 900
    sc = json.loads(subprocess.run([sys.executable, "-I", f"{B}/score.py", task, f"{B}/runs/{run}"], capture_output=True, text=True).stdout)
    rows.append(dict(run=run, task=task, effort=effort, rep=int(rep), state="active?" if fresh else "settled",
                     cost=round(cost, 5), out_tokens=out, turns=turns, secs=round(max(times) - min(times)),
                     effort_seen=sorted(efforts), ok=sc["ok"], passed=sc["passed"], total=sc["total"], fails=sc.get("fails")))
json.dump(rows, open(f"{B}/results.json", "w"), indent=1)
if "-q" not in sys.argv:
    for r in rows:
        if r["state"] == "not-started": continue
        print(f'{r["run"]:28} {r["state"]:8} {"PASS" if r["ok"] else "fail"} {r["passed"]}/{r["total"]} ${r["cost"]:.4f} out={r["out_tokens"]:6} turns={r["turns"]:2} {r["secs"]:4}s eff={",".join(r["effort_seen"])}')
