# Hydra

Hydra on demand (/hydra): Claude leads, Command Code heads implement; plus a usage pane (/limits) for both

A Claude Code dev mod (v0.2.0). Claude leads the session; Command Code "heads" take on implementation work. `/hydra` starts it on demand, and `/limits` opens a usage pane covering both.

## How a Head runs
- Command Code's headless mode blocks edits and shell commands unless they are pre-approved, so each Head runs in `dont-ask` mode with Hydra's rules, written to the project's `.commandcode/settings.local.json` (added to `.git/info/exclude`). A settings file the person wrote is never touched.
- Allowed: edits inside `cwd`, read-only shell commands, and the patterns a task lists in `allowShell`. Always denied: `.git` and `.commandcode` edits, commit/push/reset/checkout/switch/restore/stash/clean/rebase/merge, `rm -r`, `rm -f`, `sudo`.
- `addDirs` grants read access to folders outside `cwd` (mockups, briefs, other repos).
- A Head that stops before ending its report with `HEAD DONE` (a text-only reply, an empty model reply, a turn cap) is resumed in the same session, up to 8 rounds, and told which calls stay denied. A run that fails before it has a session is retried twice.
- Limits: `maxMinutes` (default 40) per Head, at most 6 Heads at once (the rest queue in order).
- `background: true` returns at once; the report arrives later as a message from the plugin.
- Each report lists the files that Head edited and every denied call, read from its own transcript, plus cost, rounds and turns.

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
5. Start a new session and run `/hydra opus`. It answers `🐉 Hydra on · Lead … · Head <model>`, and the `mcp__hydra__head` tool lists `addDirs`, `allowShell`, `maxMinutes` and `background`. A tool without those is an older copy.

Plugin options (`userConfig` in `.claude-plugin/plugin.json`): `headModel` (default `deepseek/deepseek-v4.1-flash`), `headsPlan`, `headsFiveHourUsd`, `headsWeeklyUsd`.

## Smoke test
Run this after installing and after any change to how a Head is launched, before real work.

1. Make a throwaway git repo with `a.txt` containing `hello`.
2. Run one Head there with `allowShell: ["touch *"]` and `addDirs` naming one folder outside the repo and outside `/tmp` (the OS temp folder is always readable, so it proves nothing). Ask it to: edit `a.txt`; create `b.txt`; run `touch c.txt`; run `git commit -am x`; read a file in the `addDirs` folder; read a file in a different outside folder.
3. Check the file system yourself. Expected: the edit, the new file, `touch` and the `addDirs` read succeed; the commit and the other outside read are denied. The report says `finished`, lists `a.txt` and `b.txt` as edited, and lists both denied calls.
4. Run two Heads with `background: true` on two throwaway repos: both reports arrive as messages from the plugin, and the status line shows `2 running` while they work.

When something fails, the Head's transcript is `~/.commandcode/projects/<project-slug>/<sessionId>.jsonl` (the session id is in the report); `python3 bin/cc-usage.py --report <sessionId>` summarises its cost, edited files and denied calls.

## Changing Hydra
- Edit the repo, then copy it to `~/.claude/mods/hydra` with the `rsync` line above. A session reloads the mod when the turn that changed it ends, never in the middle of a turn.
- Before committing: `claude plugin validate .`, `claude plugin test .`, and `npx -p typescript tsc -p . --noEmit` (the type check needs `.claude-plugin/types/`, which a loaded copy generates).
- Then run the smoke test. Unit tests cannot show what Command Code allows; only a live Head can.

## Pitfalls already learned
- Command Code's `-p` (headless) mode denies edits, writes and shell commands unless they are pre-approved, in every permission mode except `yolo`. `accept-edits` does not help, and `auto-accept` is only an alias for it. `dont-ask` plus allow rules is the safe way in.
- One denied call cancels every other call in the same batch ("Skipped — another tool call in this batch was denied"), and a model that keeps hitting denials often ends the run. Grant what a Head needs up front (`addDirs`, `allowShell`) rather than relying on retries.
- Command Code ends a `-p` run on any text-only reply, and some models reply with text before acting ("I'll start by reading…"). That is why every task ends with the `HEAD DONE` rule and unfinished runs are resumed.
- Exit codes: 0 done, 8 turn cap, 9 empty model reply. All three are resumable.
- A plugin's `command.run` hook must not call `$.command.run` (the engine refuses it and nothing answers the command), so `/hydra` only tells the person to run `/model`.
- Parallel Heads share one checkout. Give them disjoint files, and read each report's own edited-file list rather than `git status`.
- Heads cannot build an Xcode project safely in a shared checkout (a fresh build folder clones every package); the Lead builds and tests.

## Layout
- `.claude-plugin/` — the mod manifest
- `hooks/` — the hooks that drive it
- `bin/` — helper scripts
- `types/` — shared types

The SDK type definitions in `.claude-plugin/types/` are generated by the dev-mods tooling and are not committed.

Part of the [claude-catalogue](https://github.com/Shakibuzzaman3104/claude-catalogue).
