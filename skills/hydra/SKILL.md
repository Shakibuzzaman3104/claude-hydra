---
name: hydra
description: Use Codex as the lead and delegate well-defined implementation tasks to guarded Command Code Heads. Apply when the user asks for Hydra, Heads, or Command Code delegation.
---

# Hydra for Codex CLI

You are the lead. A Head is a Command Code agent that edits the project. Its task and the files it reads are sent to the selected Command Code model. The runner uses `--yolo` with project deny rules and a write guard. Do not run a Head when those rules cannot be installed.

The runner is `bin/hydra-codex.py` at the plugin root (two directories above this skill). Use its absolute path. Run it from the target project directory:

```sh
python3 /path/to/hydra/bin/hydra-codex.py run --cwd "$PWD" --name prefs-utils --task-file /path/to/task.txt
```

Write the Head's full brief to a temporary text file. Include its goal, exact files, constraints, and acceptance check. For a short brief, pass it as the positional `task` argument. Optional flags: `--model`, `--effort` (`off`, `low`, `medium`, `high`, `xhigh`, `max`), `--max-turns`, `--max-minutes`, `--add-dir` for extra reading, `--write-dir` for a specific existing folder outside the project, and `--shell`. The default model is `deepseek/deepseek-v4.1-flash`; the default effort is `low`.

Use `--shell` only when the task requires shell access and the reachable folders contain no real secrets. The runner denies destructive commands, network tools, builds, and installs even with `--shell`. A Head cannot safely run the build or tests; do those yourself.

Give independent Heads disjoint files. You may run independent CLI calls concurrently, but they share the same checkout. Read each Head's report and inspect its diff. Run the appropriate build or tests yourself, fix or retry failures, and report the Head cost. `python3 /path/to/hydra/bin/hydra-codex.py usage` shows Command Code spending windows.

The Codex integration is a skill and runner. It does not add Claude Code's `/hydra`, `/heads`, or status line UI to Codex CLI. If the user asks to stop using Hydra, stop launching Heads and continue in Codex.
