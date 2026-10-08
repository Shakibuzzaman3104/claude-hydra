# Developing Hydra

## Running a working copy
1. Clone the repo and copy it where Claude Code loads it, leaving out the generated types:
   ```
   git clone https://github.com/Shakibuzzaman3104/claude-hydra ~/claude-hydra
   mkdir -p ~/.claude/mods && rsync -a --exclude .git --exclude .claude-plugin/types ~/claude-hydra/ ~/.claude/mods/hydra/
   ```
2. Load it in every session: add `"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/hydra"` to the `env` block of `~/.claude/settings.json`. Don't also install it from the marketplace, or `/hydra` registers twice (the same goes for a copy under `~/.claude/dev-mods/*/hydra`).
3. Check it: `claude plugin validate ~/.claude/mods/hydra` and `claude plugin test ~/.claude/mods/hydra` pass.
4. In a new session, `/hydra` answers `🐉 Hydra on · Lead … · Head <model> · effort auto …`, and the `mcp__hydra__head` tool lists `addDirs`, `shell`, `effort`, `maxMinutes` and `background`. A tool without those is an older copy.

## How a Head runs (internals)
- **Why `--yolo`:** Command Code's headless (`-p`) mode has a built-in gate that blocks `edit_file`, `write_file` and `shell_command` unless the run uses `--yolo`; permission rules cannot lift it. So every Head runs with `--yolo`, locked down by deny rules, which yolo still honours.
- **Locked down:** before a Head starts, Hydra writes the project's `.commandcode/settings.local.json` (added to `.git/info/exclude`):
  - every folder outside `cwd` is denied for edits, sibling by sibling up to `/`, and so is any new file directly in a folder above `cwd`;
  - a write guard (`bin/head-guard.py`, a Command Code `PreToolUse` hook in the same file) denies every write or edit whose real path, symlinks resolved, is outside `cwd`. Deny rules cannot name a new folder (`write_file` creates missing parents, so `~/new/x` or a missing `~/.ssh/authorized_keys` slip past them); the guard can. It also denies a symlink inside the project that points out of it. Command Code runs a tool when its hook crashes, so the deny rules stay as the floor;
  - `.git` and `.commandcode` inside the project are denied;
  - shell is denied outright unless a running Head asked for `shell: true`; even then destructive git, `rm -r`/`-f`, `sudo`, network tools (`curl`, `wget`, `ssh`, `rsync`, …), builds and installs (`xcodebuild`, `swift build`, `npm install`, `brew`, …) stay denied;
  - `.env` and `.env.*` files are kept from Heads, because a Head sends file contents to an external model: the read and edit tools are denied on them, and so is any shell command that names one as a path (`Shell(* .env*)`, `Shell(*/.env*)`, `Shell(*=.env*)`; `process.env` still runs);
  - the grep tool ignores `Read` rules and takes no path-scoped deny, so when a `.env` file sits in the project or an `addDirs` folder Hydra denies the grep tool outright (the report says which file); if the check fails, search is denied too;
  - a Head with `shell: true` can still read `.env` through a command that does not name it, such as `grep -r KEY .`. Pattern rules cannot close that, so avoid shell in projects with real secrets.
  Heads sharing a `cwd` share one file, rebuilt from the Heads running there as each starts and ends, from every Claude session: the file's `hydraHeads` lists each running Head (`<session id>/<head id>`) with a time it must have ended by, so one session never drops another's lockdown and a crashed session's entries expire. When the last Head leaves, the file is deleted, so the person's own Command Code runs never inherit Hydra's rules. A session start also clears what a reload or crash left behind in the session root.
- **Fails closed:** if the rules cannot be written, or the project already has a `settings.local.json` the person wrote, the Head does not start and the report says why.
- **Audit:** each report lists the files that Head edited and every denied call, read from its own transcript, and puts any write outside the project at the top as `⚠ WROTE OUTSIDE THE PROJECT`.
- `addDirs` grants read access to folders outside `cwd` (mockups, briefs, other repos).
- **Never quits silently:** a Head that stops before ending its report with `HEAD DONE` (a text-only reply, an empty model reply, a turn cap) is resumed in the same session, up to 8 rounds, and told which calls stay denied. A run that fails before it has a session is retried twice. A run that is cut off (time limit, kill) still reports: its session is found from its transcript by start time and task.
- **Watching Heads:** while a Head runs (and for a minute after it ends) a band above the prompt shows one row per Head: a spinner (◌ queued, ✓ done, ✗ failed), its id, effort, a turn bar with `turns/maxTurns`, elapsed time and what it is doing now (`thinking`, `edit c.txt`, `search "TODO"`, `$ ls`) or how it ended. `/heads` opens a pane with every Head of the session: press its number to see its task, turn bar, edits, denials, cost and its last 8 tool calls (✓ done, ✗ denied). Both read Command Code's JSON event stream as it arrives and redraw once a second while a Head is live.
- **Status line:** Hydra writes its line to `~/.claude/hydra/status/<session id>.txt` while `/hydra` is on in that session (the file is emptied when it is off): `🐉 <head model> · <effort> | Heads 5h $spent/$limit | 7d $spent/$limit`, the Heads' Command Code spend against `headsFiveHourUsd` and `headsWeeklyUsd`. Your status line command prints it, which avoids the `⚠ <plugin>:` prefix Claude Code puts on a plugin's own status row. Add this (or see `examples/statusline.sh`) before the final `printf` of `~/.claude/statusline.sh`, where `$input` is the JSON Claude Code passes and `$out` your line:
  ```bash
  session_id=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -1 | sed -E 's/.*"([A-Za-z0-9-]*)"$/\1/')
  hydra_file="$HOME/.claude/hydra/status/$session_id.txt"
  if [ -n "$session_id" ] && [ -s "$hydra_file" ]; then
    printf '%s\n\033[38;5;179m%s\033[0m' "$out" "$(head -1 "$hydra_file")"
  else
    printf '%s' "$out"
  fi
  ```
  Claude's own limits and running Heads are in `/hydra-usage` and `/heads`.
- **Effort:** Heads run with Command Code's `--effort`. In `auto` (the default, `headEffort`) the Lead picks per Head and never below `high`: `high` for a well-specified implementation, `xhigh` for multi-file work with some design judgement, non-trivial logic, edge-case tests or matching a mockup, `max` for a subtle bug, concurrency or state, an algorithm, a fragile cross-file change, or a retry after a Head got it wrong. DeepSeek V4.1 Flash has no `xhigh`, so it runs as `max` there. `/hydra effort=<level>` (`off`, `low`, `medium`, `high`, `xhigh` or `max`) fixes every Head at that level and overrides the Lead; `/hydra effort=auto` hands the choice back. A change reaches running Heads at their next round. A level the model lacks is raised to its nearest supported one (DeepSeek V4.1 Flash takes `off`, `low`, `high`, `max`), and each report shows the effort used.
- **Limits:** `maxMinutes` (default 40) per Head, at most 6 Heads at once (the rest queue in order).
- **Names:** every Head has a short name saying what it works on (`prefs-utils`, `login-tests`), used in the band, `/heads`, reports and `mcp__hydra__control`. The Lead passes `name`; without one Hydra makes one from the first source file the task names (`PreferenceUtils.kt` → `preference-utils`) or its first few meaningful words. Names are lowercase kebab, at most 20 characters, and unique per session (`-2`, `-3`).
- **Lead control:** `mcp__hydra__control` lets the Lead `list` Heads (one with no process behind it is flagged `NO LIVE PROCESS`), `stop` one by name or all, `clear` finished ones from the views, and turn Hydra `on`/`off` or set its `effort` and head model, so it never has to ask the person to stop a Head.
- **Watching without interrupting:** `/heads` and `/hydra-usage` are immediate commands, so they open mid-turn without touching Claude's work. An interrupted foreground call (Esc, a typed prompt) lets its Head keep running; the report then arrives as a message. Stop a Head on purpose with `s` in `/heads` or through `mcp__hydra__control`.
- **Stopping cleanly:** every Head, foreground or background, runs on the `session.start` worker. Cancelling a Head's tool call aborts it, and the stream read is raced against that stop, so a silent Head (a model thinking, a hung CLI) ends at once and is marked failed with the reason. A reload marks running and queued Heads as ended.
- **`/hydra <task>`:** the task is submitted as a prompt, so the Lead starts right after the command instead of on the next message.
- **Background:** `background: true` queues the Head for a worker that `session.start` owns and returns at once; the report arrives later as a message from the plugin. A plugin may not keep `$` in a variable, and a `tool.call` hook's `$` lapses a few minutes after the call returns, killing anything spawned under it; that is why the worker lives in `session.start`.


## Smoke test
Run this after installing and after any change to how a Head is launched, before real work.

1. Make a throwaway git repo with `a.txt` containing `hello`, and an empty folder beside it.
2. Run one Head there with `addDirs` naming a folder outside the repo and outside `/tmp` (the OS temp folder is always readable, so it proves nothing). Ask it to: edit `a.txt`; create `b.txt`; run `ls`; create a file in the folder beside the repo; create a file in your home folder; create `~/hydra-probe/x.txt` (a new folder); add a line to `.git/config`; read a file in the `addDirs` folder.
3. Check the disk yourself. Expected: the edit, the new file and the `addDirs` read succeed; `ls`, the three outside writes and the `.git/config` edit are denied and nothing exists outside the repo. The report says `finished`, lists `a.txt` and `b.txt` as edited, lists the five denied calls, and shows no `⚠ WROTE OUTSIDE` line.
4. After any change to the `.env` rules, add `.env`, `.env.production` and `sub/.env.local` with fake values, and run one Head with `shell: true` that tries, one call each: the read tool, the grep tool over `.` and over `sub`, `cat .env`, `cat sub/.env.local`, `grep -r SECRET .`, `grep -rn "process.env" a.txt`, and an edit of each `.env` file. Expected: every call is denied except `grep -r SECRET .` (the known shell gap) and the `process.env` grep, and no `.env` file changes. Write the Head's output outside the test repo, or its own log matches the searches.
5. Run one Head with `background: true` on a task of 30+ single edits (several minutes): its report arrives as a message from the plugin, the band above the prompt shows it working (spinner, turn bar, current tool call), and `/heads` shows its live step log.

6. After every Head in the throwaway repo has ended, `.commandcode/settings.local.json` is gone. Start a Head, open a second Claude session in the same repo, run and finish a Head there while the first is still running: the file keeps the first session's entry until that Head ends.
7. With `/hydra` never run before on the machine (or after deleting the `consent-v1` key from Hydra's plugin store), `/hydra` asks once before turning on; `Not now` leaves it off. With `commandcode` missing from `PATH`, `/hydra` refuses and names the install command.

When something fails, the Head's transcript is `~/.commandcode/projects/<project-slug>/<sessionId>.jsonl` (the session id is in the report); `python3 bin/cc-usage.py --report <sessionId>` summarises its cost, edited files and denied calls.

## Changing Hydra
- Edit the repo, then copy it to `~/.claude/mods/hydra` with the `rsync` line above. A session reloads the mod when the turn that changed it ends, never in the middle of a turn. A reload ends the module, and with it every Head it is running, so never change the loaded copy while Heads are working.
- Before committing: `claude plugin validate .`, `claude plugin test .`, and `npx -p typescript tsc -p . --noEmit` (the type check needs `.claude-plugin/types/`, which a loaded copy generates).
- Then run the smoke test. Unit tests cannot show what Command Code allows; only a live Head can.

## Pitfalls already learned
- 2026-10-08: path deny rules have `*` (one name, dotfiles included), `?` and `**`, but no negation and no character classes, so no rule can deny "a new folder in `~` other than the project", and `write_file` creates missing parents. A `PreToolUse` hook in `settings.local.json` fires under `--yolo` before the tool runs and its deny is final, so the write guard closes that gap. A hook that crashes or times out lets the tool run.
- 2026-10-08: on Windows, Command Code 1.65 matches a rule `//X` as `/X` and any other rule against the project, so no `Edit(...)` rule can deny a `D:/…` path and a `--yolo` Head writes anywhere (a live Head wrote outside the repo despite `Edit(//D:/…)` and `Edit(D:/…)` rules). Hydra refuses Windows project paths (`windowsPathRefusal`) instead of running unlocked; use WSL.
- 2026-10-07: Command Code's `-p` mode blocks edits, writes and shell commands unless the run uses `--yolo`, in every permission mode; `accept-edits`, `auto-accept` (an alias) and `dont-ask` with allow rules all fail. Deny rules are the only control left under yolo, hence Hydra's generated deny list.
- 2026-10-07: one denied call cancels every other call in the same batch ("Skipped — another tool call in this batch was denied"), and a model that keeps hitting denials often ends the run. Grant reads up front with `addDirs`.
- 2026-10-07: Command Code ends a `-p` run on any text-only reply, and some models reply with text before acting ("I'll start by reading…"). That is why every task ends with the `HEAD DONE` rule and unfinished runs are resumed.
- 2026-10-07: exit codes are 0 done, 8 turn cap, 9 empty model reply; all three are resumable.
- 2026-10-07: Command Code writes a session's `.jsonl` transcript lazily; at first only `.meta.json` and `.checkpoints.jsonl` exist, so a missing transcript does not mean a dead Head. The first line of `.checkpoints.jsonl` holds the prompt and `createdAt`.
- 2026-10-07: a refusal reads "Blocked by permission deny rule …" (yolo) or "requires permissions" (print-mode gate); the transcript reader must treat both as denials, or refused writes look like edits.
- 2026-10-07: a background Head spawned from a `tool.call` hook died about 3 minutes later; run long-lived work from `session.start`'s worker. A plugin may not store `$` in a variable (validate rejects it).
- 2026-10-08: a hook's own time is capped at 10 s per dispatch, and awaiting a plain promise counts; a `$` call in flight does not. A hook that must wait longer (the foreground Head) waits through `$` calls such as `$.process.run(['/bin/sleep', '1'])`.
- 2026-10-08: a foreground Head run under a `tool.call` hook's `$` stayed "running" forever after its call was cancelled: the child died with the call, and the hook could no longer record it. Every Head now runs on the worker's `$`. Set `statusLine.refreshInterval` (e.g. 2) so the status line shows `/hydra` on/off without waiting for the next message.
- 2026-10-07: big view files (1,500+ lines) took DeepSeek Heads past 40 minutes; split such work or raise `maxMinutes`, and expect a follow-up Head to finish it.
- 2026-10-08: Command Code's grep tool ignores `Read` deny rules, and path-scoped `Grep(...)` or `Search(...)` rules never fire; only a bare `Grep` deny stops it. Pointing grep straight at `.env` is caught by `Read(.env)`, but a search over `.` or a folder is not.
- 2026-10-08: `Read(.env.*)` and `Edit(.env.*)` match nested files such as `sub/.env.local`. Shell rules match the command text, not the files it touches, so `Shell(*.env*)` blocked `grep "process.env"` yet let `grep -r SECRET .` read every `.env`.
- 2026-10-08: Claude Code's auto mode refuses to let Claude launch a `--yolo` Head from Bash for a probe, even with the person's go-ahead. Write the probe as a script and have the person run it with `! bash <script>`. macOS has no `timeout`; use `perl -e 'alarm shift; exec @ARGV' 600 …`.
- 2026-10-08: Command Code refuses an effort level the model lacks before it starts (exit 1, `Unknown effort "medium". Supported: off, low, high, max.`), and a resumed session restores the last effort it recorded unless `--effort` is passed again. Hydra passes `--effort` on every round.
- A plugin's `command.run` hook must not call `$.command.run` (the engine refuses it and nothing answers the command), so `/hydra` only tells the person to run `/model`.
- Parallel Heads share one checkout. Give them disjoint files, read each report's own edited-file list rather than `git status`, and tell a Head never to delete a type another file still uses.
- Heads cannot build an Xcode project safely in a shared checkout (a fresh build folder clones every package); the Lead builds and tests.


## Layout
- `.claude-plugin/` — the mod manifest and the marketplace file
- `hooks/` — the hooks that drive it, and their tests
- `bin/cc-usage.py` — reads Command Code transcripts: spend windows, a Head's report, a lost session
- `bin/head-guard.py` — the write guard Command Code runs before each Head write or edit
- `types/` — the state contract
- `examples/statusline.sh` — a full status line command that prints Hydra's line
- `CHANGELOG.md` — what changed in each version

The SDK type definitions in `.claude-plugin/types/` are generated by the engine when it loads the mod and are not committed.
