# Hydra

Claude leads, cheaper coding agents do the typing. Hydra is a Claude Code plugin. With it on, Claude plans the work, hands self-contained implementation tasks to **Heads** (agents on a cheaper model, run through the Command Code or CodeBuddy CLI), then reviews their diffs and runs the build itself.

```
🐉 Hydra 2 running · 1 done · 31k tok · $0.0213 · /heads for detail
⠹ login-tests  codex       high   ███░░░░░ 14/150 3:12 edit LoginViewModelTest.kt
⠹ prefs-utils  agy         medium █░░░░░░░  5/150 1:04 search "SharedPreferences"
✓ api-client   commandcode high   ██░░░░░░ 11/60  2:40 done · $0.0213
```

The engine shows on each row when Claude picks one per Head (auto mode). `/heads` adds the totals and a timeline of the session:

```
🐉 Hydra · Auto (Command Code + Codex + Antigravity) · gpt-6.1-sol · effort auto
1 running · 1 queued · 2 done · 1 failed · 4:00 wall
12 edits · 1 denied · 105k tok · $0.0336
codex 2 · agy 2 · commandcode 1
Timeline 4:00 span
✓ api-client     ━━━━━━━━━━━━━━━━━━━━────────────────────  2:00
✓ prefs-utils    ──────━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━───  3:00
⠋ login-tests    ───────────────────────━━━━━━━━━━━━━━━━━  1:40
✗ flaky-spec     ───────────────────────────────━━━──────  0:10
◌ docs-pass      ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄     –
```

- **`/hydra`** turns it on for the session, on whichever engines are ready on your machine. `/hydra <task>` turns it on and hands Claude the task.
- **`/heads`** shows the Heads live: totals (counts, tokens, dollars, edits, denials, wall time), the timeline, and per Head its turn count, current step, edits, denied calls and final report. Press `s` to stop one.
- **`/hydra-usage`** shows Claude's limits next to what the Heads have spent, and what this session's Heads used per engine.
- **`/hydra help`** lists everything.

### First run
Install the plugin, then run `/hydra`. With the default `headEngine` of `auto`, Hydra checks which engines are installed and signed in:
- **One is ready:** it runs on that one and says so (`Using Codex (the only engine ready here).`).
- **Two or more:** Claude picks the engine for each Head from the task.
- **None:** a short card lists each engine with what to run, the ones with the easiest start first, ending with `then run /hydra again`.

Hydra asks once before anything is sent to an engine. The first time it turns on, it adds three lines on what happens next (Claude splits the work, `/heads` to watch, `/hydra off` to stop). Set `headEngine` to one engine to keep it fixed.

## Requirements
- macOS or Linux (on Windows, use WSL), with `git` and `python3`
- Claude Code
- One Head engine, signed in:
  - the [Command Code](https://commandcode.ai) CLI:
    ```
    npm i -g command-code
    commandcode        # once, to sign in
    ```
  - or the CodeBuddy CLI:
    ```
    npm i -g @tencent-ai/codebuddy-code
    codebuddy          # once, to sign in
    ```
  - or the Codex CLI (OpenAI, on your ChatGPT plan; its sandbox uses bubblewrap on Linux):

    ```
    npm i -g @openai/codex
    codex login        # once, to sign in (codex login --device-auth on a remote machine)
    ```

  Codex Heads default to `gpt-6.1-sol`; the Lead passes `model: "gpt-6-luna"` for mechanical or small tasks. Codex has no per-tool rules, so a Head runs in Codex's OS sandbox with a filesystem profile Hydra writes: writes only in the project (and `writeDirs`), no `.git` writes, no `.env` reads, no credential folders, no network.

  - or the Antigravity CLI (Google): `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then `agy` once to sign in (Google OAuth). Antigravity Heads always run `gemini-3.8-flash`. `agy` has one global settings file, so each Head gets its own `HOME` with permission rules; its sandbox keeps a shell inside the project with no network.

  Choose with the `headEngine` option, or `/hydra engine=codebuddy` / `engine=codex` / `engine=agy` for one session.

  **Auto:** `/hydra engine=auto` (all ready engines) or `/hydra engines=codex,agy,codebuddy` (a pool) lets Claude choose the engine for each Head from the task: hard or test-running work to Codex, bulk or reading work to Antigravity, well-specified edits to the cheap DeepSeek engines. `/hydra engines` shows which engines are ready and what each is for. The routing guide is Claude's judgement from how the engines run, not a cross-engine benchmark.

## Install
In Claude Code:
```
/plugin install hydra --marketplace Shakibuzzaman3104/claude-hydra
```
Answer `y` to add the marketplace and pick the user scope. Then run `/hydra`. The first time, it checks your setup and asks before anything is sent to the Head model.

## What a Head can and can't do
A Head runs its CLI unattended. On Command Code that is `--yolo` (its headless mode can't edit otherwise), locked down by deny rules that Hydra writes before the Head starts and removes after it ends. On CodeBuddy it is `default` permission mode with a per-Head settings file (`--settings`, kept outside the project) that allows edits only under the project, plus the same write guard. Either way:
- it can edit files inside the project, but not `.git`, `.commandcode` or `.env` files. Every write outside it is denied, including into new folders and through symlinks;
- when a task has to change a folder outside the project (a symlinked package's real location, a sibling repo), Claude passes that folder in `writeDirs`. It must exist, and can't be `/`, your home folder or a folder above the project. Its `.git`, `.commandcode` and `.env` files stay protected, and Heads running in the same project at the same time share the grant;
- it can read folders outside the project only when Claude passes them in `addDirs`;
- it has no shell unless Claude asks for one. Even then, destructive git, `rm -r`/`-f`, `sudo`, network tools, builds and installs are denied;
- every report lists the files the Head edited and every call that was denied. A write outside the project is flagged at the top.

**Your code leaves your machine.** Each Head's task, and every file it reads, goes to the Head model through Command Code, CodeBuddy, Codex or Antigravity. Leave Hydra off in projects whose code must not leave your machine. A Head with shell access can still read a `.env` file through a command that doesn't name it (`grep -r KEY .`), so Claude avoids giving Heads a shell in projects with real secrets.

## Settings
Change these in `/config` (the Hydra rows) or when installing:

| Option | Default | What it does |
| --- | --- | --- |
| `headEngine` | `auto` | The CLI Heads run on: `commandcode`, `codebuddy`, `codex` or `agy`, or `auto` to use the engines that are ready here (`/hydra engine=<name>` for one session) |
| `headModel` | `deepseek/deepseek-v4.1-flash` | Model the Heads run on (`/hydra head=<model>` for one session); on CodeBuddy the provider prefix is dropped (`deepseek-v4.1-flash`) |
| `headEffort` | `auto` | `auto` lets Claude pick per Head: `low` when it will check the result, one level up on each retry, `max` first only for subtle work it cannot check (measured in `bench/effort/`); a level fixes it (`/hydra effort=<level>`) |
| `headsFiveHourUsd`, `headsWeeklyUsd` | `0` | Your Command Code plan's spend caps; with `0`, spend is shown without a limit |
| `headsPlan` | empty | Your plan's name, shown in `/hydra-usage` |

## Status line (optional)
While Hydra is on, it writes `🐉 <head model> · <effort> | Heads 5h $… | 7d $…` to `~/.claude/hydra/status/<session id>.txt`. To show it under your own status line, `/hydra statusline` prints the lines to add. [`examples/statusline.sh`](examples/statusline.sh) is a full script. Add `"refreshInterval": 2` to the `statusLine` block of `~/.claude/settings.json`, or the line only updates at your next message. Without it, the band above the prompt and `/heads` show the same thing.

## Troubleshooting
- **`/hydra` says it can't start:** it names what's missing and what to run.
- **"settings.local.json holds your own Command Code rules":** Hydra needs that file to lock Heads down. Move your rules to `.commandcode/settings.json` (Command Code reads both).
- **A Head failed:** its report gives the session id. On Command Code the transcript is at `~/.commandcode/projects/<project>/<session id>.jsonl` and `commandcode --resume <session id>` opens it; on CodeBuddy use `codebuddy --resume <session id>`.
- **CodeBuddy, Codex and Antigravity show tokens, not dollars:** they count credits, plan usage or account quota, so `/hydra-usage` has no Heads spend while the engine is one of them; each Head's report and `/heads` row show its tokens.
- **A very large file (1,500+ lines)** can take a Head past its 40-minute limit. Ask Claude to split the work.

Building on Hydra or changing how it works: see [DEVELOPING.md](DEVELOPING.md). Changes by version are in [CHANGELOG.md](CHANGELOG.md).
