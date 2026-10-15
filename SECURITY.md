# Security Policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

1. Open the repository's **Security** tab on GitHub.
2. Choose **Report a vulnerability** to open a private security advisory.
3. Describe the issue, the engine and OS you tested on, and steps to reproduce.

Direct link: https://github.com/Shakibuzzaman3104/claude-hydra/security/advisories/new

Reports are acknowledged as soon as practical. Fixes for confirmed issues are
released in a new minor version, and the advisory is published once a fix ships.

## Supported versions

Only the latest minor version receives security fixes. Older versions should be
upgraded.

## Threat model

Hydra hands implementation work to a Head: an unattended coding agent running on
a third-party model. Hydra's job is to stop that Head from:

- writing outside the project directory,
- reading `.env` files or credential folders,
- using the network,
- running destructive shell commands.

**In scope** (any escape from these rules on a supported engine and OS):

- A Head writing, deleting or moving files outside the project.
- A Head reading `.env` files or credential directories through its own tools.
- A Head making network requests that the lockdown should block.
- A Head running a destructive or network command that the lockdown should block.
- Hydra itself leaking secrets or credentials into logs, the terminal pane or
  reports.

**Out of scope:**

- The Head's model provider seeing the code and prompts you send it. This is by
  design and is disclosed in the README.
- A Head given `shell: true` reading a `.env` file through a command that does
  not name the file. This is a documented limitation of shell access.
