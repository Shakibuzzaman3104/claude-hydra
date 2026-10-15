# Contributing to Hydra

Thanks for helping out. Keep changes small and focused, and open an issue first
for anything larger than a bug fix.

## Dev setup

```sh
git clone https://github.com/Shakibuzzaman3104/claude-hydra.git
cd claude-hydra
claude --plugin-dir .   # loads the plugin for one session
```

## Checks before opening a PR

Run all four and make sure they pass:

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit
python -m pytest tests/python
```

## Launch and lockdown changes

Any change to how a Head is launched or locked down needs a live smoke test.
Follow the procedure in [DEVELOPING.md](DEVELOPING.md), and paste the result into
your PR. Unit tests alone are not enough for these changes.

## Adding an engine

1. Add one file in `hooks/engines/` that implements the engine.
2. Register it in `hooks/lib/engines.ts`.
3. Add a lockdown section and a smoke test for it to `DEVELOPING.md`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

- `feat: add the OpenCode engine`
- `fix: stop the Head reading .env files on Windows`
- `docs: explain engine routing`

## Source file headers

Every new source file starts with the author header used in the repo:

```ts
/**
 * @author <your name>
 * @since DD/MM/YY
 */
```

## Pull requests

Fill in the PR template. Link the related issue, list the checks you ran, and
add a CHANGELOG entry for any user-visible change.
