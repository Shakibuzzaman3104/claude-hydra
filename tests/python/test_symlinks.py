"""
@author Shakib
@since 15/10/26
"""
import json
import os
import sys

import pytest

from conftest import make_symlink, run_script


def scan(*roots):
    result = run_script("symlinks.py", *roots)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_lists_every_link_with_its_real_target_without_following_or_skipping(tmp_path):
    project = tmp_path / "app"
    sibling = tmp_path / "sibling"
    (project / ".git").mkdir(parents=True)
    (project / "node_modules" / "deep" / "er" / "and" / "deeper" / "still" / "more" / "levels" / "here").mkdir(parents=True)
    sibling.mkdir()
    make_symlink(project / "link-out", sibling)
    make_symlink(project / ".git" / "in-git", sibling)
    make_symlink(project / "node_modules" / "deep" / "er" / "and" / "deeper" / "still" / "more" / "levels" / "here" / "far", sibling)
    make_symlink(project / "self", project)
    make_symlink(project / "dangling", tmp_path / "nowhere")
    found = {os.path.relpath(link, project): target for link, target in scan(project)}
    real = os.path.realpath
    assert found == {
        "link-out": real(sibling),
        os.path.join(".git", "in-git"): real(sibling),
        os.path.join("node_modules", "deep", "er", "and", "deeper", "still", "more", "levels", "here", "far"): real(sibling),
        "self": real(project),
        "dangling": real(tmp_path / "nowhere"),
    }


def test_scans_every_root_and_skips_one_that_does_not_exist(tmp_path):
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    make_symlink(second / "up", tmp_path)
    assert scan(first, tmp_path / "missing", second) == [[str(second / "up"), os.path.realpath(tmp_path)]]


@pytest.mark.skipif(sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0), reason="needs POSIX permissions as a normal user")
def test_fails_when_a_folder_cannot_be_listed(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0)
    try:
        result = run_script("symlinks.py", tmp_path)
    finally:
        locked.chmod(0o755)
    assert result.returncode == 2
    assert "cannot list" in result.stderr
