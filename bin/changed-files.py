#!/usr/bin/env python3
"""Lists files changed under the given folders since a time (ms since epoch): the files a Codex Head edited.

Codex's stream names only some edits (patches), not what a shell command wrote, so Hydra asks the file system.
In a git repository the candidates are the modified and the new, non-ignored files; elsewhere a walk that skips
.git and dependency or build folders. Prints a JSON list of absolute paths, at most 500.

`--snapshot <dir>...` prints the uncommitted files under the folders and their sha1, at most 500 and skipping files
over 5 MB, so a Head's report can tell its own edits from ones that were already there. `--compare <snapshot-file>
<since-ms> <dir>...` prints the snapshot files that changed and still differ from git (`overwritten`), and the ones
that are back to the committed version or gone (`reverted`), and the tracked files written since `since` that match
the committed version now (`restored`): rewritten during the run, maybe with no change, maybe undoing an edit.
"""
import hashlib
import json
import os
import subprocess
import sys

LIMIT = 500
MAX_BYTES = 5 * 1024 * 1024
SKIP = {'.git', 'node_modules', '.gradle', 'build', '.idea', '__pycache__', '.venv'}


def git_listing(root, *flags):
    """The paths git lists under `root` for `flags`, or None outside a repository."""
    try:
        ran = subprocess.run(['git', '-C', root, 'ls-files', '-z', *flags], capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if ran.returncode != 0:
        return None
    return [os.path.join(root, name.replace('/', os.sep)) for name in ran.stdout.decode('utf-8', 'replace').split('\0') if name]


def git_candidates(root):
    """The modified and new, non-ignored files git lists under `root`, or None outside a repository."""
    return git_listing(root, '-m', '-o', '--exclude-standard')


def candidates(root):
    listing = git_candidates(root)
    if listing is not None:
        yield from listing
        return
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for name in files:
            yield os.path.join(folder, name)


def digest(path):
    """The file's sha1, or None when it is gone, unreadable or over 5 MB."""
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return None
        hasher = hashlib.sha1()
        with open(path, 'rb') as file:
            for block in iter(lambda: file.read(1 << 16), b''):
                hasher.update(block)
        return hasher.hexdigest()
    except OSError:
        return None


def snapshot(roots):
    """The uncommitted files under `roots` and their sha1, as they stood before a Head ran."""
    hashes = {}
    for root in roots:
        for path in git_candidates(root) or []:
            if len(hashes) >= LIMIT:
                return hashes
            if path not in hashes:
                sha = digest(path)
                if sha is not None:
                    hashes[path] = sha
    return hashes


def compare(snapshot_path, since_ms, roots):
    """The snapshot files a Head changed and left changed, and the ones it put back to the committed version or deleted.

    A tracked file written since `since` that is not modified now and was not in the snapshot goes to `restored`:
    it was rewritten during the run and matches the committed version, which also covers a formatter that changed nothing.
    """
    with open(snapshot_path, encoding='utf-8') as file:
        before = json.load(file)
    since = since_ms / 1000
    uncommitted, modified, tracked = set(), set(), set()
    for root in roots:
        uncommitted.update(git_candidates(root) or [])
        modified.update(git_listing(root, '-m') or [])
        tracked.update(git_listing(root) or [])
    overwritten, reverted, restored = [], [], []
    for path, sha in sorted(before.items()):
        if path not in uncommitted or not os.path.isfile(path):
            reverted.append(path)
            continue
        now = digest(path)
        if now is not None and now != sha:
            overwritten.append(path)
    for path in sorted(tracked - set(before) - modified):
        if len(restored) >= LIMIT:
            break
        try:
            if os.path.isfile(path) and os.stat(path).st_mtime >= since:
                restored.append(path)
        except OSError:
            continue
    return {'overwritten': overwritten[:LIMIT], 'reverted': reverted[:LIMIT], 'restored': restored[:LIMIT]}


def main():
    args = sys.argv[1:]
    if args[:1] == ['--snapshot']:
        print(json.dumps(snapshot(args[1:])))
        return
    if args[:1] == ['--compare'] and len(args) > 2:
        print(json.dumps(compare(args[1], float(args[2]), args[3:])))
        return
    since = float(args[0]) / 1000
    changed = []
    for root in args[1:]:
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
