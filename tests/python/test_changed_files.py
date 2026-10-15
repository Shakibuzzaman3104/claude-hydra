"""
@author Shakib
@since 15/10/26
"""
import json
import os
import shutil
import subprocess
import time

import pytest

from conftest import run_script

OLD = time.time() - 3 * 24 * 3600


def changed(since_seconds, *roots):
    result = run_script("changed-files.py", int(since_seconds * 1000), *roots)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def relative(paths, root):
    return sorted(os.path.relpath(path, root).replace(os.sep, "/") for path in paths)


def write(path, text="x", mtime=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def git(root, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.com", *args], check=True, capture_output=True)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_in_a_git_repository_lists_modified_and_new_files_but_not_ignored_or_old_ones(tmp_path):
    root = tmp_path / "repo"
    write(root / ".gitignore", "ignored.log\nbuild/\n", mtime=OLD)
    write(root / "tracked.txt", "one", mtime=OLD)
    write(root / "stale.txt", "one", mtime=OLD)
    write(root / "untouched.txt", "one", mtime=OLD)
    git(root, "init", "-q")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    since = time.time() - 60
    write(root / "tracked.txt", "changed text")  # modified, fresh mtime
    write(root / "stale.txt", "changed text", mtime=OLD)  # modified, but older than since
    write(root / "new.txt")  # untracked, not ignored
    write(root / "sub" / "deep.txt")
    write(root / "ignored.log")  # untracked, ignored
    write(root / "build" / "out.bin")  # ignored folder
    write(root / "old-new.txt", mtime=OLD)  # untracked but older than since
    assert relative(changed(since, root), root) == ["new.txt", "sub/deep.txt", "tracked.txt"]


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_a_deleted_file_is_not_listed(tmp_path):
    root = tmp_path / "repo"
    write(root / "gone.txt", mtime=OLD)
    git(root, "init", "-q")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    (root / "gone.txt").unlink()
    assert changed(time.time() - 60, root) == []


def test_without_a_git_repository_it_walks_and_skips_dependency_and_build_folders(tmp_path):
    root = tmp_path / "plain"
    for name in ("a.txt", "sub/b.txt", "node_modules/x.js", ".git/config", "build/o.bin", "__pycache__/m.pyc", ".venv/p.py", "sub/node_modules/y.js"):
        write(root / name)
    write(root / "old.txt", mtime=OLD)
    assert relative(changed(time.time() - 60, root), root) == ["a.txt", "sub/b.txt"]


def test_several_roots_are_merged_and_sorted(tmp_path):
    first, second = tmp_path / "one", tmp_path / "two"
    write(first / "b.txt")
    write(second / "a.txt")
    paths = changed(time.time() - 60, first, second)
    assert paths == sorted(paths)
    assert sorted(os.path.basename(path) for path in paths) == ["a.txt", "b.txt"]


def test_a_time_in_the_future_lists_nothing(tmp_path):
    write(tmp_path / "a.txt")
    assert changed(time.time() + 3600, tmp_path) == []


def test_a_missing_folder_lists_nothing(tmp_path):
    assert changed(time.time() - 60, tmp_path / "nope") == []
