"""Run a task's hidden tests against a directory: python3 -I score.py <task> <dir> -> JSON {passed, total, ok}."""
import json, os, subprocess, sys, pathlib
B = pathlib.Path(__file__).resolve().parent
task, run_dir = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
test = B / "hidden" / task / "test_hidden.py"
code = f"""
import sys, unittest, json
sys.path.insert(0, {str(run_dir)!r})
loader = unittest.TestLoader(); suite = loader.discover({str(test.parent)!r}, pattern='test_hidden.py')
res = unittest.TextTestRunner(stream=open('/dev/null','w'), verbosity=0).run(suite)
fails = [str(t[0]).split()[0] for t in res.failures + res.errors]
print(json.dumps({{"total": res.testsRun, "failed": len(res.failures) + len(res.errors), "fails": fails}}))
"""
env = dict(os.environ, RUN_DIR=str(run_dir), PYTHONDONTWRITEBYTECODE="1")
try:
    p = subprocess.run([sys.executable, "-c", code], cwd=str(test.parent), env=env, capture_output=True, text=True, timeout=120)
    out = json.loads(p.stdout.strip().splitlines()[-1])
except Exception as e:
    out = {"total": 0, "failed": 0, "fails": [], "error": repr(e)[:300]}
out["passed"] = out["total"] - out["failed"]; out["ok"] = out["total"] > 0 and out["failed"] == 0
print(json.dumps(out))
