# Hydra

Claude leads, cheaper coding agents do the typing. Hydra is a Claude Code plugin. With it on, Claude plans the work, hands self-contained implementation tasks to **Heads** (Command Code agents on a cheaper model), then reviews their diffs and runs the build itself.

```
🐉 Hydra 2 running · 1 done · /heads for detail
⠹ login-tests  xhigh ███░░░░░ 14/60  3:12 edit LoginViewModelTest.kt
⠹ prefs-utils  high  █░░░░░░░  5/60  1:04 search "SharedPreferences"
✓ api-client   high  ██░░░░░░ 11/60  2:40 done · $0.0213
```

- **`/hydra`** turns it on for the session. `/hydra <task>` turns it on and hands Claude the task.
- **`/heads`** shows each Head live: its turn count, current step, edits, denied calls and final report. Press `s` to stop one.
- **`/hydra-usage`** shows Claude's limits next to what the Heads have spent.
- **`/hydra help`** lists everything.

## Requirements
- macOS or Linux (on Windows, use WSL), with `git` and `python3`
- Claude Code
- The [Command Code](https://commandcode.ai) CLI, signed in:
  ```
  npm i -g command-code
  commandcode        # once, to sign in
  ```

## Install
In Claude Code:
```
/plugin install hydra --marketplace Shakibuzzaman3104/claude-hydra
```
Answer `y` to add the marketplace and pick the user scope. Then run `/hydra`. The first time, it checks your setup and asks before anything is sent to the Head model.

## What a Head can and can't do
A Head runs Command Code unattended (`--yolo`; its headless mode can't edit otherwise), locked down by deny rules that Hydra writes before the Head starts and removes after it ends:
- it can edit files inside the project, but not `.git`, `.commandcode` or `.env` files. Every write outside it is denied, including into new folders and through symlinks;
- it can read folders outside the project only when Claude passes them in `addDirs`;
- it has no shell unless Claude asks for one. Even then, destructive git, `rm -r`/`-f`, `sudo`, network tools, builds and installs are denied;
- every report lists the files the Head edited and every call that was denied. A write outside the project is flagged at the top.

**Your code leaves your machine.** Each Head's task, and every file it reads, goes to the Head model through Command Code. Leave Hydra off in projects whose code must not leave your machine. A Head with shell access can still read a `.env` file through a command that doesn't name it (`grep -r KEY .`), so Claude avoids giving Heads a shell in projects with real secrets.

## Settings
Change these in `/config` (the Hydra rows) or when installing:

| Option | Default | What it does |
| --- | --- | --- |
| `headModel` | `deepseek/deepseek-v4.1-flash-fast` | Command Code model the Heads run on (`/hydra head=<model>` for one session) |
| `headEffort` | `auto` | `auto` lets Claude pick `high`, `xhigh` or `max` per Head; a level fixes it (`/hydra effort=<level>`) |
| `headsFiveHourUsd`, `headsWeeklyUsd` | `0` | Your Command Code plan's spend caps; with `0`, spend is shown without a limit |
| `headsPlan` | empty | Your plan's name, shown in `/hydra-usage` |

## Status line (optional)
While Hydra is on, it writes `🐉 <head model> · <effort> | Heads 5h $… | 7d $…` to `~/.claude/hydra/status/<session id>.txt`. To show it under your own status line, `/hydra statusline` prints the lines to add. [`examples/statusline.sh`](examples/statusline.sh) is a full script. Without it, the band above the prompt and `/heads` show the same thing.

## Troubleshooting
- **`/hydra` says it can't start:** it names what's missing and what to run.
- **"settings.local.json holds your own Command Code rules":** Hydra needs that file to lock Heads down. Move your rules to `.commandcode/settings.json` (Command Code reads both).
- **A Head failed:** its report gives the session id. The transcript is at `~/.commandcode/projects/<project>/<session id>.jsonl`, and `commandcode --resume <session id>` opens it.
- **A very large file (1,500+ lines)** can take a Head past its 40-minute limit. Ask Claude to split the work.

Building on Hydra or changing how it works: see [DEVELOPING.md](DEVELOPING.md). Changes by version are in [CHANGELOG.md](CHANGELOG.md).
