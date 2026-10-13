#!/usr/bin/env python3
"""Lists files changed under the given folders since a time (ms since epoch): the files a Codex Head edited.

Codex's stream names only some edits (patches), not what a shell command wrote, so Hydra asks the file system.
In a git repository the candidates are the modified and the new, non-ignored files; elsewhere a walk that skips
.git and dependency or build folders. Prints a JSON list of absolute paths, at most 500.
"""
import json
import os
import subprocess
import sys

LIMIT = 500
SKIP = {'.git', 'node_modules', '.gradle', 'build', '.idea', '__pycache__', '.venv'}


def candidates(root):
    try:
        ran = subprocess.run(['git', '-C', root, 'ls-files', '-z', '-m', '-o', '--exclude-standard'], capture_output=True, timeout=20)
        if ran.returncode == 0:
            for name in ran.stdout.decode('utf-8', 'replace').split('\0'):
                if name:
                    yield os.path.join(root, name)
            return
    except (OSError, subprocess.SubprocessError):
        pass
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for name in files:
            yield os.path.join(folder, name)


def main():
    since = float(sys.argv[1]) / 1000
    changed = []
    for root in sys.argv[2:]:
        for path in candidates(root):
            try:
                if os.path.isfile(path) and os.stat(path).st_mtime >= since:
                    changed.append(path)
            except OSError:
                continue
            if len(changed) >= LIMIT:
                break
    print(json.dumps(sorted(set(changed))))


if __name__ == '__main__':
    main()
