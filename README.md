# Hydra

Claude leads, cheaper coding agents do the typing. Hydra is a Claude Code plugin. With it on, Claude plans the work, hands self-contained implementation tasks to **Heads** (agents on a cheaper model, run through the Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode CLI), then reviews their diffs and runs the build itself.

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

  Codex Heads default to `gpt-6.1-sol`; the Lead passes `model: "gpt-6-luna"` for mechanical or small tasks. If your ChatGPT plan does not offer `gpt-6.1-sol`, Heads fall back to `gpt-6-luna` and their reports say so. Codex has no per-tool rules, so a Head runs in Codex's OS sandbox with a filesystem profile Hydra writes: writes only in the project (and `writeDirs`), no `.git` writes, no `.env` reads, nothing in your home folder except the project, `addDirs` and toolchain folders, no credential folders, no network.

  - or the Antigravity CLI (Google): `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then `agy` once to sign in (Google OAuth). Antigravity Heads run `gemini-3.8-flash` by default, and Claude can pick `gemini-4-argon`, `claude-sonnet-5-5`, `claude-opus-5-5` or `gpt-oss-120b` per Head. Claude + GPT-OSS, Gemini Flash and Gemini 4 Argon are separate usage pools (the Gemini ones have only a weekly limit), so a limit in one leaves the others free. `agy` has one global settings file, so each Head gets its own `HOME` with permission rules; its sandbox keeps a shell inside the project with no network.

  - or WorkBuddy: the CodeBuddy CLI pointed at the [WorkBuddy](https://www.workbuddy.ai) app's product config, so Heads run DeepSeek V4.1 Flash on your WorkBuddy plan (credits). Install the WorkBuddy app and sign in once (it writes `~/.workbuddy-ai/cache/acc-product-config-v3.json`), then:

    ```
    npm i -g @tencent-ai/codebuddy-code
    CODEBUDDY_CONFIG_DIR=~/.claude/hydra/workbuddy-cli ACC_PRODUCT_CONFIG_PATH=~/.workbuddy-ai/cache/acc-product-config-v3.json codebuddy
    /login             # inside CodeBuddy, once
    ```

    WorkBuddy Heads run exactly like CodeBuddy ones (same rules and write guard), in their own config folder.

  - or OpenCode (**beta**): `curl -fsSL https://opencode.ai/install | bash` (or `npm i -g opencode-ai`). Its free models (`opencode/deepseek-v4.1-flash-free`, the default) need no account; `opencode auth login` adds providers, and Claude may pass any `provider/model` you set up. Built against OpenCode v2. **Its lockdown is weaker** than the other engines': OpenCode's own permission rules only, with no OS sandbox and no write guard; see below.

  Choose with the `headEngine` option, or `/hydra engine=codebuddy` / `engine=codex` / `engine=agy` / `engine=workbuddy` / `engine=opencode` for one session.

  **Auto:** `/hydra engine=auto` (all ready engines) or `/hydra engines=codex,agy,codebuddy` (a pool) lets Claude choose the engine for each Head from the task: hard or test-running work to Codex, bulk or reading work to Antigravity, well-specified edits to the cheap DeepSeek engines. `/hydra engines` shows which engines are ready and what each is for. The routing guide is Claude's judgement from how the engines run, not a cross-engine benchmark.

## Install
In Claude Code:
```
/plugin install hydra --marketplace Shakibuzzaman3104/claude-hydra
```
Answer `y` to add the marketplace and pick the user scope. Then run `/hydra`. The first time, it checks your setup and asks before anything is sent to the Head model.

## What a Head can and can't do
A Head runs its CLI unattended. On Command Code that is `--yolo` (its headless mode can't edit otherwise), locked down by deny rules that Hydra writes before the Head starts and removes after it ends. On CodeBuddy it is `default` permission mode with a per-Head settings file (`--settings`, kept outside the project) that allows edits only under the project, plus the same write guard (WorkBuddy runs the same CodeBuddy setup). Codex and Antigravity add their own sandbox. Either way:
- it can edit files inside the project, but not `.git`, `.commandcode` or `.env` files. Every write outside it is denied, including into new folders and through symlinks;
- when a task has to change a folder outside the project (a symlinked package's real location, a sibling repo), Claude passes that folder in `writeDirs`. It must exist, and can't be `/`, a folder that holds the project or your home folder, or a credential folder. Its `.git`, `.commandcode` and `.env` files stay protected, and Heads running in the same project at the same time share the grant;
- it can read folders outside the project only when Claude passes them in `addDirs`. System folders and, on Codex, the toolchain folders in your home (git config, nvm, cargo, gradle…) stay readable so builds and tests run; add more with the `headReadDirs` option;
- it never reads your credentials: SSH and GPG keys, git credential stores, cloud and registry logins, keychains and the agent CLIs' own sign-ins are denied on every engine, even inside a folder Claude grants;
- it has no shell unless Claude asks for one. Even then, destructive git, `rm -r`/`-f`, `sudo`, network tools, builds and installs are denied;
- it never reads what your project's `.hydraignore` names (see below). It can't edit, delete or rename a `.hydraignore` either, and a report flags any `.hydraignore` that changed or went missing during the run;
- every report lists the files the Head edited and every call that was denied. A write outside the project is flagged at the top;
- when Claude gives it a `check`, Hydra runs that command **as you, outside the Head's lockdown**, after the Head finishes (see below). That runs code the Head may have just written, so Hydra asks you once before the first check, and the report flags a check that ran test or build files the Head changed.

**OpenCode Heads (beta) are locked down by OpenCode's own permission rules only, so their lockdown is weaker.** Hydra writes a per-Head OpenCode config (kept outside the project) that denies everything by default and allows reading the project (never `.env` files or your credential folders), editing inside it (never `.git`, `.env`, `.opencode/`, `opencode.json`, `.claude/` or `.codebuddy/`), `glob` and a todo list; `external_directory` closes everything outside the project except `writeDirs` and `addDirs`. OpenCode's rules are case-sensitive and a macOS disk is not, so `.git` and `.env` are denied in every letter case (`.GIT`, `.Env.local`…). Verified live against OpenCode v2.0.18 with 18 probes (see the changelog). What is different:
- there is no OS sandbox and no write guard (OpenCode has no hook to run one): the rules are all there is;
- an OpenCode Head **never** has a shell, even when Claude asks for one, because OpenCode does not check a shell command's paths. It has no search tool either (OpenCode's grep reads `.env` files), and no web, subagents or code tool, so Claude names the exact files in the task;
- it runs only with `cwd` at a repository's root. Hydra refuses it in a monorepo subfolder (OpenCode would let it reach the whole repository), and refuses an `addDirs`/`writeDirs` folder that holds a credential folder (such as your home folder);
- every symlink in the project and the granted folders is listed when the Head starts. One that leads out, or around a deny (`a -> .`, a link to `.git` or `.env`), is denied by its own path, in any letter case. If the links can't be listed, or more than 100 need denying, the Head is refused. A link created later (no OpenCode Head can make one) is not covered;
- not covered: hard links (pnpm's store links files into `node_modules`, so editing one edits the store copy), project files that run code later (`.envrc`, `package.json` scripts, `.vscode/tasks.json`), and project secrets that `.hydraignore` does not name;
- its own config folder (`~/.config/opencode`, which can hold API keys) is replaced by an empty one per Head, so providers defined only there are not available to Heads; sign providers in with `opencode auth login` instead.

### Keeping more files from Heads: `.hydraignore`
`.env` files are kept from Heads everywhere. For other secrets (`local.properties`, keystores, `google-services.json`, a `secrets/` folder), put a `.hydraignore` at the root of the project, in gitignore syntax:

```
local.properties
app/google-services.json
*.jks
secrets/
```

When a Head starts, Hydra asks git which paths it matches (tracked or not, patterns anchored at the file's folder, so a monorepo subfolder works) and denies each one as it denies `.env`: no reads, edits or search, and shell lines that name it are refused. It works the same in an `addDirs` or `writeDirs` folder with its own `.hydraignore`. A Head may read `.hydraignore` but not change it: edits, and shell lines that name it, are denied, and every run ends by comparing each `.hydraignore` with how it started, flagging one that was removed or changed (`⚠ .hydraignore REMOVED OR CHANGED`). Hydra never treats an unreadable list as empty: the Head is refused when the folder is not in a git repository, git fails or times out, or the file matches more than 200 paths (name the folder instead of the files in it). Files that start matching mid-run are covered from the next Head on.

Per engine (verified live on macOS, a case-insensitive disk; see the changelog):
- **Codex, Command Code, OpenCode:** reads are refused in any letter case (`LOCAL.PROPERTIES`), and so are `grep -r` (Codex's sandbox) or the search tool (removed on the others);
- **CodeBuddy and WorkBuddy:** reads are refused in any case. Their search tool walks into files the read rules deny, so it is removed while a match is in reach (Claude names exact files in the task);
- **Antigravity:** its rules name one exact spelling, so on a disk that ignores case Hydra writes a rule for every spelling of each protected path below the project (`.Env`, `SECRETS/KEY.TXT`…). That caps out at 4,096 rules: a long name (`local.properties` alone has 32,768 spellings) refuses the Antigravity Head, and in auto mode Claude routes the task to another engine. Short names (`secrets/`, `*.jks` matches like `a.jks`) fit.

### Acceptance checks
Claude can give a Head a `check`, a shell command such as `./gradlew testDebugUnitTest --tests LoginViewModelTest`. When the Head finishes, Hydra runs it in the project:
- **passed:** the report says `check: … ✓ passed`. Claude still reads the diff;
- **failed:** the Head is sent back with the check's last 60 lines of output, one effort level up (unless you fixed the level), at most twice. The report shows every try (`3 tries: ✗ ✗ ✓`) and, if it never passed, `✗ FAILED` with the output;
- **could not run** (not found, no start, over its time limit): the report says `? UNKNOWN` and the Head is not retried. A Head that did not finish is never checked.

What to know:
- the check runs as you, with your environment, outside every Head's lockdown, and Claude Code's Bash prompt is not involved. Hydra asks once (`Run checks`) before the first one. It runs code the Head may have written (tests, build scripts), so the report adds `⚠ the check ran code this Head changed (…)` when the Head edited test or build files or a file the check names;
- on a failure the check's output goes to the Head's model with the task. A test suite that prints secrets would send them;
- one run of a check is limited to 10 minutes (`checkMinutes`, at most 10), and fix rounds come out of the Head's own `maxMinutes`. Stopping a Head while its check runs takes effect when the check ends;
- Heads sharing a project see each other's edits, so Claude gives checks only to Heads whose result does not depend on another running Head.

**Your code leaves your machine.** Each Head's task, and every file it reads, goes to the Head model through Command Code, CodeBuddy, Codex, Antigravity, WorkBuddy or OpenCode. Leave Hydra off in projects whose code must not leave your machine. A Head with shell access can still read a `.env` file through a command that doesn't name it (`grep -r KEY .`), so Claude avoids giving Heads a shell in projects with real secrets.

## Settings
Change these in `/config` (the Hydra rows) or when installing:

| Option | Default | What it does |
| --- | --- | --- |
| `headEngine` | `auto` | The CLI Heads run on: `commandcode`, `codebuddy`, `codex`, `agy`, `workbuddy` or `opencode` (beta), or `auto` to use the engines that are ready here (`/hydra engine=<name>` for one session) |
| `headModel` | `deepseek/deepseek-v4.1-flash` | Model the Heads run on (`/hydra head=<model>` for one session); on CodeBuddy and WorkBuddy the provider prefix is dropped (`deepseek-v4.1-flash`); OpenCode takes `provider/model` and defaults to `opencode/deepseek-v4.1-flash-free` |
| `headEffort` | `auto` | `auto` lets Claude pick per Head: `low` when it will check the result, one level up on each retry, `max` first only for subtle work it cannot check (measured in `bench/effort/`); a level fixes it (`/hydra effort=<level>`) |
| `headsFiveHourUsd`, `headsWeeklyUsd` | `0` | Your Command Code plan's spend caps; with `0`, spend is shown without a limit |
| `headsPlan` | empty | Your plan's name, shown in `/hydra-usage` |
| `headReadDirs` | empty | More folders in your home that Codex Heads may read (comma separated, e.g. `~/tools, ~/.config/mytool`), on top of the toolchain folders Hydra opens; one that holds a credential folder is ignored |
| `accountStrategy` | `fill` | With several accounts on an engine: `fill` uses the default first and moves on at a usage limit, `spread` rotates, least recently used first |

## Several accounts
Hit a usage limit on one subscription? Give an engine more than one account and Hydra moves on by itself. Every engine has a `default` account (the CLI's normal sign-in); Codex, CodeBuddy, Antigravity, WorkBuddy and OpenCode can have more (an extra OpenCode account has its own data folder, so OpenCode's free models do not work on it: sign it in to a provider).
- `/hydra accounts` lists each engine's accounts with ✓ signed in / ✗ not signed in, and `cooling until HH:MM` for one at its limit. Command Code keeps one account.
- `/hydra accounts add codex work` makes a folder for the account and prints the exact login command to run (for Codex, `CODEX_HOME="…" codex login`). Run it in a separate terminal and sign in there with the CLI itself.
- `/hydra accounts remove codex work` forgets the account (its folder stays; the reply names the path to delete). `/hydra accounts reset` clears every cooldown.
- When a Head stops at a usage limit, Hydra marks that account as cooling (for the wait the CLI names, else an hour) and re-runs the Head on the next account with a note listing the files already changed. The report starts with `accounts: codex/default (usage limit, cooling until 14:05) → codex/work`. If every account of an engine is cooling, the Head does not start; in auto mode Claude routes that task to another engine.
- The `accountStrategy` option picks the order: `fill` (default) uses the default account until it is at its limit; `spread` rotates, least recently used first.

Hydra never reads or stores a credential: each account's sign-in lives in the CLI's own config folder (`~/.claude/hydra/accounts/<engine>/<name>/`), and the folder is the only thing Hydra points the CLI at.

## Status line (optional)
While Hydra is on, it writes `🐉 <head model> · <effort> | Heads 5h $… | 7d $…` to `~/.claude/hydra/status/<session id>.txt`. To show it under your own status line, `/hydra statusline` prints the lines to add. [`examples/statusline.sh`](examples/statusline.sh) is a full script. Add `"refreshInterval": 2` to the `statusLine` block of `~/.claude/settings.json`, or the line only updates at your next message. Without it, the band above the prompt and `/heads` show the same thing.

## Troubleshooting
- **`/hydra` says it can't start:** it names what's missing and what to run.
- **"settings.local.json holds your own Command Code rules":** Hydra needs that file to lock Heads down. Move your rules to `.commandcode/settings.json` (Command Code reads both).
- **A Head failed:** its report gives the session id. On Command Code the transcript is at `~/.commandcode/projects/<project>/<session id>.jsonl` and `commandcode --resume <session id>` opens it; on CodeBuddy use `codebuddy --resume <session id>`, on OpenCode `opencode run -s <session id>`.
- **An OpenCode Head says it hung:** OpenCode sometimes prints nothing at all. Hydra stops a run with no output for 90 seconds (or 5 minutes mid-run), retries it once in the same session, then reports the hang.
- **An OpenCode Head was refused before it ran:** the reason says which rule. A monorepo subfolder, a home-folder grant, or a project with links Hydra can't list or too many to deny needs another engine (or `cwd` at the repository root).
- **CodeBuddy, WorkBuddy, Codex, Antigravity and OpenCode show tokens, not dollars:** they count credits, plan usage or account quota, so `/hydra-usage` has no Heads spend while the engine is one of them; each Head's report and `/heads` row show its tokens.
- **A very large file (1,500+ lines)** can take a Head past its 40-minute limit. Ask Claude to split the work.
- **"`.hydraignore` could not be read":** Hydra reads it with git, so the folder must be in a git repository (`git init` it, or remove the file). The reason names what git said.
- **"`.hydraignore` matches N paths":** more than 200 matches is too many to deny one by one. Name a folder (`secrets/`) instead of the files in it.
- **An Antigravity Head was refused on a Mac:** a macOS disk ignores letter case, so Hydra denies each protected path in every spelling, and a long name (`local.properties`) needs too many rules, or a granted folder holds a credential folder. Use another engine for that project, or `/hydra engine=auto` and Claude routes around it.
- **"The person has not agreed to let Hydra run checks":** the one-time question was dismissed, or Claude Code runs headless (`-p`), where nobody can answer. Claude then runs the build or tests itself.
- **A check says `? UNKNOWN`:** the command was not found, could not start or ran past `checkMinutes`. Run it yourself to see why; Hydra does not retry it.

Building on Hydra or changing how it works: see [DEVELOPING.md](DEVELOPING.md). Changes by version are in [CHANGELOG.md](CHANGELOG.md).
