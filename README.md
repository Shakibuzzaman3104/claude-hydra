# Hydra

Hydra on demand (/hydra): Claude leads, Command Code heads implement; plus a usage pane (/limits) for both

A Claude Code dev mod (v0.4.3). Claude leads the session; Command Code "heads" take on implementation work. `/hydra` starts it on demand, and `/limits` opens a usage pane covering both.

## How a Head runs
- **Why `--yolo`:** Command Code's headless (`-p`) mode has a built-in gate that blocks `edit_file`, `write_file` and `shell_command` unless the run uses `--yolo`; permission rules cannot lift it. So every Head runs with `--yolo`, locked down by deny rules, which yolo still honours.
- **Locked down:** before a Head starts, Hydra writes the project's `.commandcode/settings.local.json` (added to `.git/info/exclude`):
  - every folder outside `cwd` is denied for edits, sibling by sibling up to `/`;
  - `.git` and `.commandcode` inside the project are denied;
  - shell is denied outright unless a running Head asked for `shell: true`; even then destructive git, `rm -r`/`-f`, `sudo`, network tools (`curl`, `wget`, `ssh`, `rsync`, …), builds and installs (`xcodebuild`, `swift build`, `npm install`, `brew`, …) stay denied;
  - `.env` and `.env.*` files are kept from Heads, because a Head sends file contents to an external model: the read and edit tools are denied on them, and so is any shell command that names one as a path (`Shell(* .env*)`, `Shell(*/.env*)`, `Shell(*=.env*)`; `process.env` still runs);
  - the grep tool ignores `Read` rules and takes no path-scoped deny, so when a `.env` file sits in the project or an `addDirs` folder Hydra denies the grep tool outright (the report says which file); if the check fails, search is denied too;
  - a Head with `shell: true` can still read `.env` through a command that does not name it, such as `grep -r KEY .`. Pattern rules cannot close that, so avoid shell in projects with real secrets.
  Heads sharing a `cwd` share one file, rebuilt from the Heads running there as each starts and ends.
- **Fails closed:** if the rules cannot be written, or the project already has a `settings.local.json` the person wrote, the Head does not start and the report says why.
- **Audit:** each report lists the files that Head edited and every denied call, read from its own transcript, and puts any write outside the project at the top as `⚠ WROTE OUTSIDE THE PROJECT`.
- `addDirs` grants read access to folders outside `cwd` (mockups, briefs, other repos).
- **Never quits silently:** a Head that stops before ending its report with `HEAD DONE` (a text-only reply, an empty model reply, a turn cap) is resumed in the same session, up to 8 rounds, and told which calls stay denied. A run that fails before it has a session is retried twice. A run that is cut off (time limit, kill) still reports: its session is found from its transcript by start time and task.
- **Status line:** blank until `/hydra` turns Hydra on in the session; then `🐉 Hydra · <head model> · <effort> │ 5h $spent/$limit │ 7d $spent/$limit`, the Heads' Command Code spend against `headsFiveHourUsd` and `headsWeeklyUsd`. Claude's own limits and running Heads are in `/limits`.
- **Effort:** Heads run with Command Code's `--effort`. In `auto` (the default, `headEffort`) the Lead picks per Head and never below `high`: `high` for a well-specified implementation, `xhigh` for multi-file work with some design judgement, non-trivial logic, edge-case tests or matching a mockup, `max` for a subtle bug, concurrency or state, an algorithm, a fragile cross-file change, or a retry after a Head got it wrong. DeepSeek V4.1 Flash has no `xhigh`, so it runs as `max` there. `/hydra effort=<level>` (`off`, `low`, `medium`, `high`, `xhigh` or `max`) fixes every Head at that level and overrides the Lead; `/hydra effort=auto` hands the choice back. A change reaches running Heads at their next round. A level the model lacks is raised to its nearest supported one (DeepSeek V4.1 Flash takes `off`, `low`, `high`, `max`), and each report shows the effort used.
- **Limits:** `maxMinutes` (default 40) per Head, at most 6 Heads at once (the rest queue in order).
- **Background:** `background: true` queues the Head for a worker that `session.start` owns and returns at once; the report arrives later as a message from the plugin. A plugin may not keep `$` in a variable, and a `tool.call` hook's `$` lapses a few minutes after the call returns, killing anything spawned under it; that is why the worker lives in `session.start`.

## Install
macOS or Linux only: the mod calls `/usr/bin/env python3` and `git`.

1. Prerequisites: `python3`, `git`, the `gh` CLI signed in to an account that can read this private repo, and the Command Code CLI (`npm i -g command-code`). On a machine where Command Code has never run, the person runs `commandcode` once in a terminal to sign in.
2. Put the mod where Claude Code loads it, leaving out the generated types:
   ```
   gh repo clone Shakibuzzaman3104/claude-hydra ~/claude-hydra
   mkdir -p ~/.claude/mods && rsync -a --exclude .git --exclude .claude-plugin/types ~/claude-hydra/ ~/.claude/mods/hydra/
   ```
3. Load it in every session: add `"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/hydra"` to the `env` block of `~/.claude/settings.json`, keeping the other keys. The auto-mode classifier may block Claude from editing that file; the person then approves it or adds the line themselves.
4. Check it: `claude plugin validate ~/.claude/mods/hydra` passes and `claude plugin test ~/.claude/mods/hydra` passes every test. A second copy under `~/.claude/dev-mods/*/hydra` would register `/hydra` twice, so remove it.
5. Start a new session and run `/hydra opus`. It answers `🐉 Hydra on · Lead … · Head <model> · effort auto (Lead picks high, xhigh or max)`, and the `mcp__hydra__head` tool lists `addDirs`, `shell`, `effort`, `maxMinutes` and `background`. A tool without those is an older copy.

Plugin options (`userConfig` in `.claude-plugin/plugin.json`): `headModel` (default `deepseek/deepseek-v4.1-flash`), `headEffort` (`auto` or a level; default `auto`), `headsPlan`, `headsFiveHourUsd`, `headsWeeklyUsd`.

## Smoke test
Run this after installing and after any change to how a Head is launched, before real work.

1. Make a throwaway git repo with `a.txt` containing `hello`, and an empty folder beside it.
2. Run one Head there with `addDirs` naming a folder outside the repo and outside `/tmp` (the OS temp folder is always readable, so it proves nothing). Ask it to: edit `a.txt`; create `b.txt`; run `ls`; create a file in the folder beside the repo; create a file in your home folder; add a line to `.git/config`; read a file in the `addDirs` folder.
3. Check the disk yourself. Expected: the edit, the new file and the `addDirs` read succeed; `ls`, both outside writes and the `.git/config` edit are denied and nothing exists outside the repo. The report says `finished`, lists `a.txt` and `b.txt` as edited, lists the four denied calls, and shows no `⚠ WROTE OUTSIDE` line.
4. After any change to the `.env` rules, add `.env`, `.env.production` and `sub/.env.local` with fake values, and run one Head with `shell: true` that tries, one call each: the read tool, the grep tool over `.` and over `sub`, `cat .env`, `cat sub/.env.local`, `grep -r SECRET .`, `grep -rn "process.env" a.txt`, and an edit of each `.env` file. Expected: every call is denied except `grep -r SECRET .` (the known shell gap) and the `process.env` grep, and no `.env` file changes. Write the Head's output outside the test repo, or its own log matches the searches.
5. Run one Head with `background: true` on a task of 30+ single edits (several minutes): its report arrives as a message from the plugin, and `/limits` lists it as running while it works.

When something fails, the Head's transcript is `~/.commandcode/projects/<project-slug>/<sessionId>.jsonl` (the session id is in the report); `python3 bin/cc-usage.py --report <sessionId>` summarises its cost, edited files and denied calls.

## Changing Hydra
- Edit the repo, then copy it to `~/.claude/mods/hydra` with the `rsync` line above. A session reloads the mod when the turn that changed it ends, never in the middle of a turn. A reload ends the module, and with it every Head it is running, so never change the loaded copy while Heads are working.
- Before committing: `claude plugin validate .`, `claude plugin test .`, and `npx -p typescript tsc -p . --noEmit` (the type check needs `.claude-plugin/types/`, which a loaded copy generates).
- Then run the smoke test. Unit tests cannot show what Command Code allows; only a live Head can.

## Pitfalls already learned
- 2026-10-07: Command Code's `-p` mode blocks edits, writes and shell commands unless the run uses `--yolo`, in every permission mode; `accept-edits`, `auto-accept` (an alias) and `dont-ask` with allow rules all fail. Deny rules are the only control left under yolo, hence Hydra's generated deny list.
- 2026-10-07: one denied call cancels every other call in the same batch ("Skipped — another tool call in this batch was denied"), and a model that keeps hitting denials often ends the run. Grant reads up front with `addDirs`.
- 2026-10-07: Command Code ends a `-p` run on any text-only reply, and some models reply with text before acting ("I'll start by reading…"). That is why every task ends with the `HEAD DONE` rule and unfinished runs are resumed.
- 2026-10-07: exit codes are 0 done, 8 turn cap, 9 empty model reply; all three are resumable.
- 2026-10-07: Command Code writes a session's `.jsonl` transcript lazily; at first only `.meta.json` and `.checkpoints.jsonl` exist, so a missing transcript does not mean a dead Head. The first line of `.checkpoints.jsonl` holds the prompt and `createdAt`.
- 2026-10-07: a refusal reads "Blocked by permission deny rule …" (yolo) or "requires permissions" (print-mode gate); the transcript reader must treat both as denials, or refused writes look like edits.
- 2026-10-07: a background Head spawned from a `tool.call` hook died about 3 minutes later; run long-lived work from `session.start`'s worker. A plugin may not store `$` in a variable (validate rejects it).
- 2026-10-07: big view files (1,500+ lines) took DeepSeek Heads past 40 minutes; split such work or raise `maxMinutes`, and expect a follow-up Head to finish it.
- 2026-10-08: Command Code's grep tool ignores `Read` deny rules, and path-scoped `Grep(...)` or `Search(...)` rules never fire; only a bare `Grep` deny stops it. Pointing grep straight at `.env` is caught by `Read(.env)`, but a search over `.` or a folder is not.
- 2026-10-08: `Read(.env.*)` and `Edit(.env.*)` match nested files such as `sub/.env.local`. Shell rules match the command text, not the files it touches, so `Shell(*.env*)` blocked `grep "process.env"` yet let `grep -r SECRET .` read every `.env`.
- 2026-10-08: Claude Code's auto mode refuses to let Claude launch a `--yolo` Head from Bash for a probe, even with the person's go-ahead. Write the probe as a script and have the person run it with `! bash <script>`. macOS has no `timeout`; use `perl -e 'alarm shift; exec @ARGV' 600 …`.
- 2026-10-08: Command Code refuses an effort level the model lacks before it starts (exit 1, `Unknown effort "medium". Supported: off, low, high, max.`), and a resumed session restores the last effort it recorded unless `--effort` is passed again. Hydra passes `--effort` on every round.
- A plugin's `command.run` hook must not call `$.command.run` (the engine refuses it and nothing answers the command), so `/hydra` only tells the person to run `/model`.
- Parallel Heads share one checkout. Give them disjoint files, read each report's own edited-file list rather than `git status`, and tell a Head never to delete a type another file still uses.
- Heads cannot build an Xcode project safely in a shared checkout (a fresh build folder clones every package); the Lead builds and tests.

## Layout
- `.claude-plugin/` — the mod manifest
- `hooks/` — the hooks that drive it
- `bin/` — helper scripts
- `types/` — shared types

The SDK type definitions in `.claude-plugin/types/` are generated by the dev-mods tooling and are not committed.

Part of the [claude-catalogue](https://github.com/Shakibuzzaman3104/claude-catalogue).
