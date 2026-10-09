Add a `count` subcommand to todo_cli.py, wired the same way as `list`.
- `todo count` prints the number of open (not done) todos as a bare integer line, e.g. `2`.
- `todo count --done` prints the number of done todos; `todo count --all` prints the total. `--done` and `--all` together is a usage error (argparse mutually exclusive group, so it exits with status 2).
- Returns 0. Works when the file does not exist yet (prints 0).
Acceptance: `main(["--file", path, "count"], out)` writes "2\n" for two open todos; existing commands unchanged.
