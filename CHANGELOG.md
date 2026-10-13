# Changelog

## 0.9.0 — 2026-10-12
- **CodeBuddy engine.** Heads can run on the CodeBuddy CLI (`codebuddy -p`) as well as Command Code. Pick it with the new `headEngine` option (`commandcode` or `codebuddy`, default `codebuddy`) or per session with `/hydra engine=codebuddy` (the Lead can also set `engine` through `mcp__hydra__control`). `headModel` keeps working: CodeBuddy ids have no provider prefix, so `deepseek/deepseek-v4.1-flash` runs as `deepseek-v4.1-flash`. Everything else is unchanged: names, queue, `/heads`, background Heads, resume rounds, the `HEAD DONE` rule, effort.
- **Lockdown without `--yolo`.** A CodeBuddy Head runs in `default` permission mode, where headless mode refuses anything its rules do not allow. Hydra writes one settings file per Head (`~/.claude/hydra/heads/<session>-<head>.json`, passed with `--settings`, removed when the Head ends), so nothing lands in the project and Heads sharing a folder cannot disturb each other. The rules: edits and writes only under the project and the granted `writeDirs`; `.git` and every `.env` / `.env.*` file denied for read, edit and write; `addDirs` readable but not editable; only the built-in tools the Head needs (`--tools Read,Write,Edit,Glob,Grep`, plus `Bash` only when the task asked for a shell, with the same dangerous-command list as Command Code); settings from the user and project are ignored (`--setting-sources local`). The write guard (`bin/head-guard.py`) now also runs as a CodeBuddy `PreToolUse` hook, because path rules alone let a write through a symlink inside the project reach a folder outside it.
- **Verified live** against CodeBuddy 2.164.0 and `deepseek-v4.1-flash`: in-project edit and create succeed; a sibling folder, a new folder in the home folder, a symlink out of the project, `.git/config`, a new `.git/hooks` file, a read-only `addDirs` folder, `.env`, `sub/.env.local`, a new `.env.production`, and a read of `/etc/hostname` are all refused; Grep finds nothing in `.env`. With a shell: `ls`, `git status` and `node -e` run; `rm -rf`, `rm -r`, `git commit`, `git push`, `curl`, `cat .env`, `sudo` and `npm install` are refused.
- **Reports by tokens.** CodeBuddy reports credits, not dollars, so a CodeBuddy Head's report, band and `/heads` row show tokens (`92k in / 421 out`) and `/hydra-usage` says so instead of showing spend. The report lists edited files and refused calls from the Head's own stream (no transcript reading), and names the session to resume (`codebuddy --resume <id>`).
- **Turn cap enforced by Hydra.** CodeBuddy's own `--max-turns` is loose (a Head ran 13 turns under a cap of 2), so Hydra counts model messages itself and stops the Head at its cap.
- `/hydra status`, the Lead's policy text, the consent question, the preflight check (`codebuddy --version`) and the status line all name the engine.

## 0.8.0 — 2026-10-09
- `effort=auto` now follows a rule measured on real Heads instead of a guess. A new benchmark (`bench/effort/`: 15 tasks from a rename to a spreadsheet engine, hidden tests, reference solutions) ran 126 Heads on DeepSeek V4.1 Flash at `low`, `high` and `max`, three times each. `low` passed 95.2% at $0.0087 and 72 s a task; `high` 95.2% at $0.0118 and 94 s; `max` 97.6% at $0.0294 and 260 s. Starting at `low` and retrying one level up after a failed check passed 100% at $0.0103 and 86 s: as reliable as anything, for less than `high` alone.
- The rule the Lead gets: `low` (now also the default when it gives none) for every Head whose result it will check by running something, or by reading the diff for mechanical edits; one level up on each retry, with the failure in the task (`low`, `high`, `max`), then rewrite the brief or do it itself; `max` first only for subtle work it cannot check cheaply; never raise effort to make up for a vague brief. The Lead may pass any level from `low` to `max`.
- Checked the rule itself: five fresh Leads (three Opus, two Sonnet) given only the rule picked the expected level in all 24 situations of `bench/effort/select/` (first Heads with and without a check, retries, a migration, a hotfix).
- With a DeepSeek V4.1 Flash Head the rule notes that `medium` runs as `high` and `xhigh` as `max` (the model takes `off`, `low`, `high`, `max`), so those levels could not be measured separately.

## 0.7.5 — 2026-10-09
- Heads default to `deepseek/deepseek-v4.1-flash`, the standard V4.1 Flash deployment, instead of the `-fast` one. Set `headModel` to `deepseek/deepseek-v4.1-flash-fast` to go back.

## 0.7.4 — 2026-10-08
- Reports list a write the write guard blocked under `denied`, not `edited` (Command Code words it "Blocked by hook policy").
- When the last Head leaves, the empty `.commandcode` folder Hydra made goes too; one holding the person's own files stays.
- Smoke-tested through real Hydra Heads: in-project edits succeed; a sibling folder, a new folder in the home folder, `.git` and a symlink out of the project are denied; with `writeDirs` the symlinked write succeeds while `.env` inside and other folders stay denied; the rules file is deleted when the Head ends.

## 0.7.3 — 2026-10-08
- The status line instructions (`/hydra statusline`, README) add `"refreshInterval": 2`: without it Claude Code reruns the status line only at the next message, so `/hydra off` seemed not to clear it.

## 0.7.2 — 2026-10-08
- `writeDirs`: Claude can let a Head write to named folders outside the project, such as the real location of a symlinked package. Each is resolved to its real path and refused if it is `/`, the home folder, a folder above the project or one inside it. The deny rules leave a way down to it, the write guard accepts it, and its `.git`, `.commandcode` and `.env` files stay protected. Reports list the granted folders and don't flag writes there as outside the project. Verified live under `--yolo`: a write through a symlink to a granted folder succeeded; a `.env` inside it and a sibling folder stayed denied.

## 0.7.1 — 2026-10-08
- A Head can no longer create files outside the project. New files directly in a folder above the project are denied by rule (`Edit(//<folder>/*)`, PR #15). New folders there (`~/new/x`, a missing `~/.ssh/authorized_keys`), which no deny rule can name because `write_file` creates missing parents, are denied by a write guard: a Command Code `PreToolUse` hook (`bin/head-guard.py`) that checks each write's real path, symlinks resolved, against the project. Verified with a live `--yolo` Head.

## 0.7.0 — 2026-10-08
Ready for people other than its author.
- Install with one line: the repo is its own marketplace (`/plugin install hydra --marketplace Shakibuzzaman3104/claude-hydra`). The README is rewritten for new users; internals, the smoke test and pitfalls move to DEVELOPING.md.
- `/hydra` checks the setup first (macOS/Linux, the Command Code CLI, `python3`, `git`, a Command Code sign-in) and says what to run instead of failing inside a Head.
- The first `/hydra` asks once before any code goes to the Head model, and says how Heads are locked down. The Lead's `control on` can't skip that.
- Fix: the Head rules file (`.commandcode/settings.local.json`) is deleted when the last Head in a project ends. It used to stay, so the person's own Command Code runs there had shell and outside edits denied with no visible reason. Each running Head is listed in the file with its session and an end time, so sessions sharing a project keep each other's lockdown, and a crashed session's entries expire. A session start cleans up after a reload or crash.
- A typo is no longer a task: `/hydra stauts` or `/hydra efort=max` names the unknown option instead of turning Hydra on and sending the word to Claude. New `/hydra help` and `/hydra statusline`.
- `/limits` is now `/hydra-usage`.
- No personal defaults: the Heads' 5-hour and weekly caps default to 0 (spend shown without a limit), the plan name to empty; set them in `/config`. `headEffort` is a picker there.
- `/heads` shows a finished Head's edited files and the last lines of its report, moves with `j`/`k`, and keeps the last 20 Heads.
- Error messages say what to do (the person's own rules file, an unwritable project, a Head that could not run).
- Status files of other sessions are deleted after a week.
- A Head refuses a Windows project path instead of running unlocked: Command Code's rules cannot name a drive, so writes outside the project could not be denied (PR #13). Use WSL.

## 0.6.3 — 2026-10-08
- Heads default to `deepseek/deepseek-v4.1-flash-fast`, the high-throughput deployment of V4.1 Flash (Command Code says full weights). Same effort levels (`off`, `low`, `high`, `max`); a smoke test gave matching answers in 3 s against 5 s. Cache reads cost more ($0.02/M against $0.003/M), and Command Code has not scored it yet. Set `headModel` to `deepseek/deepseek-v4.1-flash` to go back.

## 0.6.2 — 2026-10-08
- `/heads` and `/limits` are immediate commands: they open at once mid-turn instead of interrupting Claude, which used to cancel a foreground Head.
- An interrupted foreground call (Esc, a typed prompt) no longer kills its Head: the Head keeps running and its report arrives as a message. Only a deliberate stop ends it.
- `/heads` has a Stop button (`s`) for the Head in view; `mcp__hydra__control` stop shares the same path.
- Verified live: a turn interrupted 20 s into a foreground Head left it running; it finished all 12 edits and reported as a message.

## 0.6.1 — 2026-10-08
- Fix: a foreground Head failed after 10 s with "the Head run failed before it reported". The `tool.call` hook waited on a plain promise, which counts against a hook's 10 s budget; it now waits through `$` calls (a host `sleep`), which do not. Verified live: a foreground Head ran 19 s and reported; a background Head was stopped by name through `mcp__hydra__control`.

## 0.6.0 — 2026-10-08
- Heads get short meaningful names (`prefs-utils`, `login-tests`) instead of `h` + digits: the Lead passes `name`, else Hydra makes one from the task's first source file or first words; unique per session.
- Every Head, foreground or background, runs on the session's own worker, so cancelling a Head's tool call stops it cleanly instead of leaving it shown as running. The stream read is raced against the stop signal, so a silent Head (a model thinking, a hung CLI) cannot hold a stopped run open.
- New `mcp__hydra__control` tool for the Lead: `list` the Heads (stale ones flagged NO LIVE PROCESS), `stop` one or all, `clear` finished ones, and turn Hydra `on`/`off` or set its `effort`.
- A reload marks queued Heads as ended too, not only running ones.
- `/hydra <task>` submits the task as a prompt, so the Lead starts at once instead of waiting for the next message.

## 0.5.1 — 2026-10-08
- Hydra's line moves from the plugin status row (which Claude Code prefixes with `⚠ hydra:`) to `~/.claude/hydra/status/<session id>.txt`, printed by the person's status line command. `examples/statusline.sh` shows a full script.

## 0.5.0 — 2026-10-08
- Live view of Heads: a band above the prompt (spinner, effort, turn bar, elapsed time, current tool call) while any Head is live, and a `/heads` pane listing every Head with a per-Head step log. Fed by Command Code's JSON event stream.
- New `queued` state while a Head waits for a slot.

## 0.4.3 — 2026-10-08
- Under `auto` the Lead picks `high`, `xhigh` or `max` per Head. DeepSeek V4.1 Flash has no `xhigh`, so it runs as `max` there.

## 0.4.2 — 2026-10-08
- `/hydra effort=<level>` accepts any level (`off` … `max`) as a manual override; the Lead's own pick stays at `high` or above.

## 0.4.1 — 2026-10-08
- Effort defaults to `auto`: the Lead chooses per Head. `/hydra effort=high|max` fixes it, `/hydra effort=auto` hands it back.

## 0.4.0 — 2026-10-08
- Heads run with `--effort` on every round. A level the model refuses is raised to its nearest supported one. Effort shows in reports, `/hydra status` and `/limits`.

## 0.3.2 — 2026-10-08
- The status line shows only while Hydra is on: Head model and the Heads' 5-hour and weekly spend. Lead limits stay in `/limits`.

## 0.3.1 — 2026-10-08
- Command Code's grep tool ignores `Read` deny rules, so Hydra denies it when a `.env` file is in the project or an `addDirs` folder.
- Shell rules match `.env` only as a path, so `process.env` commands run.
- Smoke test gains a `.env` step; pitfalls record the probe results.

## 0.3.0 and earlier
- Heads run under `--yolo` locked down by generated deny rules, in the background on a `session.start` worker (0.3.0). `.env` read/edit deny rules (PR #3).
- Heads can edit, and unfinished runs resume (0.2.0).
