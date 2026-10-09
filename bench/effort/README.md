# Effort benchmark

Measures what each Head effort level buys, so the `effort=auto` rule in `hooks/register.tsx` rests on data. 15 Python tasks, from a rename to a spreadsheet engine, each with hidden tests the Heads never see (`hidden/`) and a reference solution that passes them (`refs/`).

Run it again when the Head model changes:

1. Make run folders: `for t in tasks/*; do for e in low high max; do for r in 1 2 3; do d=runs/$(basename $t)-$e-r$r; cp -R $t $d; mv $d/BRIEF.md $d/TASK.md; done; done; done`
2. With `/hydra` on, start one Head per folder (`background: true`, its `effort`, `cwd` the folder) with the task: `Do the task described in TASK.md in this folder (read it first; do not edit it). Work only in this folder. You have no shell and cannot run tests: re-read your changes against every bullet before finishing.`
3. `python3 -I collect.py` scores each run (hidden tests, cost, tokens, time and the effort the transcript recorded), then `python3 -I analyze.py -v` prints pass rate and cost per task and level, and simulates fixed levels against the retry ladder.

`select/` checks the rule itself: `prompt.md` gives a fresh Lead the rule and 24 situations with known answers (`scenarios.json`).

`results-deepseek-v4.1-flash-2026-10-09.json` holds the 126 runs behind Hydra 0.8.0.
