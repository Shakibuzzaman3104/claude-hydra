"""
@author Shakib
@since 15/10/26
"""
import json
import os
import sys

import pytest

from conftest import load_script, make_symlink, run_script


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (tmp_path / "outside").mkdir()
    return root


def guard(root, event, *extra_roots, stdin=None):
    payload = stdin if stdin is not None else json.dumps(event)
    return run_script("head-guard.py", root, *extra_roots, stdin=payload)


def decision(result):
    """The hook's permission decision, or None when it printed nothing (the write is allowed)."""
    assert result.returncode == 0, result.stderr
    if not result.stdout.strip():
        return None
    output = json.loads(result.stdout)["hookSpecificOutput"]
    assert output["hookEventName"] == "PreToolUse"
    return output["permissionDecision"], output["permissionDecisionReason"]


def test_write_inside_the_project_is_allowed(project):
    event = {"tool_name": "Write", "tool_input": {"file_path": str(project / "src" / "a.txt")}, "cwd": str(project)}
    result = guard(project, event)
    assert result.stdout == ""
    assert decision(result) is None


def test_write_outside_the_project_is_denied(project, tmp_path):
    event = {"tool_name": "Edit", "tool_input": {"file_path": str(tmp_path / "outside" / "a.txt")}, "cwd": str(project)}
    verdict, reason = decision(guard(project, event))
    assert verdict == "deny"
    assert "outside the project" in reason


def test_sibling_folder_sharing_the_project_prefix_is_denied(project):
    sibling = project.parent / (project.name + "-evil")
    sibling.mkdir()
    event = {"tool_name": "Write", "tool_input": {"file_path": str(sibling / "a.txt")}, "cwd": str(project)}
    assert decision(guard(project, event))[0] == "deny"


def test_symlink_inside_the_project_pointing_outside_is_denied(project, tmp_path):
    make_symlink(project / "link", tmp_path / "outside")
    event = {"tool_name": "Write", "tool_input": {"file_path": str(project / "link" / "a.txt")}, "cwd": str(project)}
    assert decision(guard(project, event))[0] == "deny"


def test_a_granted_write_dir_is_allowed(project, tmp_path):
    granted = tmp_path / "outside"
    event = {"tool_name": "write_file", "tool_input": {"path": str(granted / "a.txt")}, "cwd": str(project)}
    assert decision(guard(project, event)) is not None  # not granted yet
    assert decision(guard(project, event, granted)) is None


def test_the_display_name_alone_marks_a_write(project, tmp_path):
    event = {"tool_name": "x", "tool_display_name": "WRITE", "tool_input": {"file_path": str(tmp_path / "outside" / "a")}, "cwd": str(project)}
    assert decision(guard(project, event))[0] == "deny"


def test_notebook_path_is_checked(project, tmp_path):
    event = {"tool_name": "NotebookEdit", "tool_input": {"notebook_path": str(tmp_path / "outside" / "n.ipynb")}, "cwd": str(project)}
    assert decision(guard(project, event))[0] == "deny"


def test_a_tool_that_does_not_write_is_ignored(project, tmp_path):
    event = {"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "outside" / "a.txt")}, "cwd": str(project)}
    assert decision(guard(project, event)) is None


@pytest.mark.parametrize("tool_input", [{}, {"file_path": ""}, {"file_path": "   "}, {"file_path": 7}, None])
def test_a_write_without_a_path_is_denied(project, tool_input):
    event = {"tool_name": "Write", "tool_input": tool_input, "cwd": str(project)}
    verdict, reason = decision(guard(project, event))
    assert verdict == "deny"
    assert "could not tell which file" in reason


@pytest.mark.parametrize("stdin", ["", "not json", "{", "[1, 2"])
def test_malformed_stdin_is_denied(project, stdin):
    verdict, reason = decision(guard(project, None, stdin=stdin))
    assert verdict == "deny"
    assert "write guard failed" in reason


def test_a_relative_path_resolves_against_the_event_cwd(project, tmp_path):
    (project / "sub").mkdir()
    inside = {"tool_name": "Write", "tool_input": {"file_path": "a.txt"}, "cwd": str(project / "sub")}
    assert decision(guard(project, inside)) is None
    escaping = {"tool_name": "Write", "tool_input": {"file_path": os.path.join("..", "..", "outside", "a.txt")}, "cwd": str(project / "sub")}
    assert decision(guard(project, escaping))[0] == "deny"


def test_a_relative_path_without_a_cwd_resolves_against_the_project(project):
    event = {"tool_name": "Write", "tool_input": {"file_path": "a.txt"}}
    assert decision(guard(project, event)) is None


def test_non_ascii_json_is_read_as_utf8(project):
    event = {"tool_name": "Write", "tool_input": {"file_path": str(project / "caf\u00e9.txt")}, "cwd": str(project)}
    result = run_script("head-guard.py", project, stdin=json.dumps(event, ensure_ascii=False))
    assert decision(result) is None


def test_is_inside_matches_whole_path_segments_only(tmp_path):
    is_inside = load_script("head-guard.py").is_inside
    root = os.path.join(str(tmp_path), "a")
    assert is_inside(root, root)
    assert is_inside(os.path.join(root, "b", "c"), root)
    assert not is_inside(root + "b", root)
    assert not is_inside(str(tmp_path), root)
    assert is_inside(os.path.join(root, "b"), root + os.sep)  # a root with a trailing separator


def test_is_inside_handles_the_filesystem_root():
    is_inside = load_script("head-guard.py").is_inside
    top = os.path.abspath(os.sep)
    assert is_inside(os.path.join(top, "anything"), top)
    assert is_inside(top, top)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows paths are case-insensitive")
def test_is_inside_ignores_case_and_slash_style_on_windows():
    is_inside = load_script("head-guard.py").is_inside
    assert is_inside("C:\\Users\\Me\\Proj\\a.txt", "c:\\users\\me\\proj")
    assert is_inside("c:\\users\\me\\proj\\a.txt", "C:/Users/Me/Proj")
    assert is_inside("D:\\a.txt", "d:\\")
    assert not is_inside("D:\\a.txt", "C:\\")
    assert not is_inside("C:\\Users\\Me\\Proj2\\a.txt", "c:\\users\\me\\proj")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows paths are case-insensitive")
def test_a_write_with_different_case_is_allowed_on_windows(project):
    event = {"tool_name": "Write", "tool_input": {"file_path": str(project).swapcase() + "\\a.txt"}, "cwd": str(project)}
    assert decision(guard(project, event)) is None
