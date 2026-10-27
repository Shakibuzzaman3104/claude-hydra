"""
@author Shakib
@since 27/10/26

head-guard.py --policy: Command Code on native Windows, where the guard runs before every tool call and is the whole lockdown.
"""
import json
import os
import sys

import pytest

from conftest import make_symlink, run_script


def decision(result):
    """The hook's denial reason, or None when it printed nothing (the call is allowed)."""
    assert result.returncode == 0, result.stderr
    if not result.stdout.strip():
        return None
    output = json.loads(result.stdout)["hookSpecificOutput"]
    assert output["hookEventName"] == "PreToolUse"
    assert output["permissionDecision"] == "deny"
    return output["permissionDecisionReason"]


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    (root / "secrets").mkdir(parents=True)
    (root / ".env").write_text("KEY=1", encoding="utf-8")
    (tmp_path / "outside").mkdir()
    return root


@pytest.fixture
def policy(tmp_path, project):
    """A policy for `project`: a granted read folder, a fake home with a key in it, and one .hydraignore match."""
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_ed25519").write_text("key", encoding="utf-8")
    (tmp_path / "brief").mkdir()
    file = tmp_path / "policy.json"
    content = {
        "write": [str(project)], "read": [str(tmp_path / "brief")], "guarded": [str(project / "secrets")],
        "home": str(home), "secrets": [".ssh", ".config/gh"],
    }
    file.write_text(json.dumps(content), encoding="utf-8")
    return {"file": file, "content": content, "home": home, "brief": tmp_path / "brief"}


@pytest.fixture
def guard(policy, project):
    def run(tool, tool_input, cwd=None):
        event = {"tool_name": tool, "tool_input": tool_input, "cwd": str(cwd or project)}
        return decision(run_script("head-guard.py", "--policy", policy["file"], stdin=json.dumps(event)))
    return run


def test_reads_and_writes_inside_the_project_are_allowed(guard, project):
    assert guard("read_file", {"file_path": str(project / "src" / "a.kt"), "offset": 1}) is None
    assert guard("read_file", {"file_path": "src/a.kt"}) is None
    assert guard("read_directory", {"path": "src"}) is None
    assert guard("glob", {"pattern": "src/**/*.{kt,kts}"}) is None
    assert guard("glob", {"pattern": "*.md", "path": "docs"}) is None
    assert guard("todo_write", {"todos": [{"content": "C:/anything"}]}) is None


def test_file_content_and_edit_text_are_not_paths(guard):
    assert guard("write_file", {"file_path": "src/b.kt", "content": "C:\\Windows\\System32 and ../../etc"}) is None
    assert guard("write_file", {"file_path": "src/b.kt", "file_content": "/etc/passwd"}) is None
    assert guard("edit_file", {"file_path": "src/a.kt", "old_string": "/etc/passwd", "new_string": "~/.ssh"}) is None
    assert guard("edit_file", {"file_path": "src/a.kt", "oldValue": "..", "new_value": "C:/x"}) is None


def test_a_granted_read_folder_is_readable_but_not_writable(guard, policy):
    assert guard("read_file", {"file_path": str(policy["brief"] / "notes.md")}) is None
    assert "outside the project" in guard("write_file", {"file_path": str(policy["brief"] / "notes.md"), "content": "x"})


@pytest.mark.parametrize("tool", ["read_file", "write_file", "edit_file", "read_directory"])
def test_every_file_tool_is_denied_outside_the_project(guard, tmp_path, tool):
    assert "outside the project" in guard(tool, {"file_path": str(tmp_path / "outside" / "a.txt")})
    assert "outside the project" in guard(tool, {"path": os.path.join("..", "outside", "a.txt")})


def test_a_sibling_sharing_the_project_prefix_is_outside(guard, project):
    assert "outside the project" in guard("read_file", {"file_path": str(project) + "-evil" + os.sep + "a.txt"})


def test_every_path_alias_is_checked_not_just_file_path(guard, tmp_path):
    outside = str(tmp_path / "outside" / "a.txt")
    for key in ("path", "filePath", "target_file", "absolute_path", "file", "pathname", "fileAbsolutePath"):
        assert "outside the project" in guard("read_file", {key: outside}), key
    assert "outside the project" in guard("read_file", {"file_path": "a.txt", "path": outside})
    assert "outside the project" in guard("read_file", {"file_path": "a.txt", "extra": {"nested": [outside]}})


@pytest.mark.parametrize("name", [".env", ".env.local", ".ENV", ".Env.Production", ".env.", ".env "])
def test_env_files_are_never_touched_in_any_spelling(guard, project, name):
    if name.endswith((" ", ".")) and sys.platform != "win32":
        pytest.skip("Windows drops trailing dots and spaces from a name; elsewhere they are other files")
    assert ".env" in guard("read_file", {"file_path": str(project / name)})
    assert ".env" in guard("write_file", {"file_path": f"sub/{name}", "content": "x"})
    assert ".env" in guard("read_directory", {"path": f"{name}/x"})


def test_credential_folders_are_never_read_even_inside_a_granted_home(guard, policy):
    policy["content"]["read"].append(str(policy["home"]))
    policy["file"].write_text(json.dumps(policy["content"]), encoding="utf-8")
    assert guard("read_file", {"file_path": str(policy["home"] / "notes.txt")}) is None
    assert "credential" in guard("read_file", {"file_path": str(policy["home"] / ".ssh" / "id_ed25519")})
    assert "credential" in guard("read_directory", {"path": str(policy["home"] / ".config" / "gh")})


def test_hydraignore_matches_are_never_touched(guard, project):
    assert ".hydraignore" in guard("read_file", {"file_path": str(project / "secrets" / "key.txt")})
    assert ".hydraignore" in guard("read_directory", {"path": "secrets"})
    assert ".hydraignore" in guard("glob", {"pattern": "secrets/*"})


@pytest.mark.parametrize("path", [".git/config", ".commandcode/settings.local.json", ".commandcode/hydra-guard.json", ".hydraignore", "sub/.git/HEAD", "sub/.hydraignore"])
def test_history_rules_and_hydraignore_are_readable_but_not_writable(guard, path):
    assert "protected" in guard("write_file", {"file_path": path, "content": "x"})
    assert "protected" in guard("edit_file", {"file_path": path, "old_string": "a", "new_string": "b"})
    assert guard("read_file", {"file_path": path}) is None


@pytest.mark.parametrize("pattern", ["../*", "../../**/*", "**/../../*", "src/../../*", "*.{txt,/etc/*}", "~/*", "*/..", "**/C:/x"])
def test_globs_cannot_climb_out(guard, pattern):
    assert guard("glob", {"pattern": pattern}) is not None


def test_a_glob_rooted_outside_is_denied(guard, tmp_path):
    assert "outside the project" in guard("glob", {"pattern": str(tmp_path / "outside") + os.sep + "*"})
    assert "outside the project" in guard("glob", {"pattern": "*.txt", "path": str(tmp_path / "outside")})


@pytest.mark.parametrize("tool", [
    "shell_command", "powershell", "grep", "read_multiple_files", "agent", "explore", "web_fetch", "web_search",
    "get_diagnostics", "task_create", "write_taste_file", "mcp__x__y", "Bash", "Read", "", None,
])
def test_tools_it_does_not_know_are_denied(guard, tool):
    assert "not available" in guard(tool, {"command": "dir", "file_path": "a.txt"})


def test_shell_and_search_say_what_to_use_instead(guard):
    assert "no shell" in guard("shell_command", {"command": "dir"})
    assert "no shell" in guard("powershell", {"command": "dir"})
    assert "read_file" in guard("grep", {"pattern": "KEY"})


def test_a_read_or_write_without_a_path_is_denied(guard):
    assert "could not tell" in guard("read_file", {})
    assert "could not tell" in guard("read_file", {"offset": 3})
    assert "could not tell" in guard("write_file", {"file_path": "  ", "content": "x"})
    assert "could not tell" in guard("edit_file", None)
    assert "could not tell" in guard("read_file", {"file_path": "a\0b"})


def test_a_symlink_out_of_the_project_is_denied(guard, project, tmp_path):
    (tmp_path / "outside" / "a.txt").write_text("x", encoding="utf-8")
    make_symlink(project / "link", tmp_path / "outside")
    assert "outside the project" in guard("read_file", {"file_path": "link/a.txt"})
    assert "outside the project" in guard("write_file", {"file_path": "link/new.txt", "content": "x"})
    assert "outside the project" in guard("glob", {"pattern": "link/*"})


def test_a_relative_path_from_a_cwd_outside_the_project_resolves_in_the_project(guard, tmp_path, project):
    (project / "a.txt").write_text("x", encoding="utf-8")
    assert guard("read_file", {"file_path": "a.txt"}, cwd=tmp_path / "outside") is None
    assert "outside the project" in guard("read_file", {"file_path": "../outside/a.txt"}, cwd=tmp_path / "outside")


@pytest.mark.skipif(sys.platform != "win32", reason="drive, device and stream paths are Windows'")
@pytest.mark.parametrize("raw", [
    "\\\\?\\C:\\Windows\\win.ini", "//?/C:/Windows/win.ini", "\\\\.\\PhysicalDrive0", "a.txt:secret", ".env::$DATA",
    "C:\\Windows\\win.ini", "C:/Windows/win.ini", "D:\\", "\\\\server\\share\\a", "//server/share/a", "C:..\\x",
])
def test_windows_only_escapes_are_denied(guard, raw):
    assert guard("read_file", {"file_path": raw}) is not None
    assert guard("write_file", {"file_path": raw, "content": "x"}) is not None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows paths are case-insensitive")
def test_the_project_in_another_case_and_slash_style_is_allowed_on_windows(guard, project):
    assert guard("read_file", {"file_path": str(project).swapcase().replace("\\", "/") + "/src/a.kt"}) is None
    assert guard("write_file", {"file_path": str(project).upper() + "\\src\\b.kt", "content": "x"}) is None


@pytest.mark.skipif(sys.platform != "win32", reason="junctions are Windows'")
def test_a_junction_out_of_the_project_is_denied(guard, project, tmp_path):
    # Unlike a symlink, a junction needs no privilege, so it is the link a Head's project is likely to hold on Windows.
    import subprocess
    (tmp_path / "outside" / "a.txt").write_text("x", encoding="utf-8")
    made = subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(project / "jn"), str(tmp_path / "outside")], capture_output=True)
    assert made.returncode == 0, made.stderr
    assert "outside the project" in guard("read_file", {"file_path": "jn/a.txt"})
    assert "outside the project" in guard("read_file", {"file_path": str(project / "JN" / "a.txt")})
    assert "outside the project" in guard("write_file", {"file_path": "jn/new/b.txt", "content": "x"})
    assert "outside the project" in guard("read_directory", {"path": "jn"})
    assert "outside the project" in guard("glob", {"pattern": "jn/**/*"})


@pytest.mark.skipif(sys.platform != "win32", reason="a short (8.3) name is Windows'")
def test_a_short_name_for_an_outside_folder_is_denied(guard, tmp_path):
    long_dir = tmp_path / "outside" / "a long folder name"
    long_dir.mkdir()
    import ctypes
    buffer = ctypes.create_unicode_buffer(1024)
    if not ctypes.windll.kernel32.GetShortPathNameW(str(long_dir), buffer, 1024) or buffer.value == str(long_dir):
        pytest.skip("8.3 names are off on this volume")
    assert "outside the project" in guard("read_file", {"file_path": buffer.value + "\\a.txt"})


@pytest.mark.parametrize("content", ["", "{", "[]", json.dumps({"write": []}), json.dumps({"read": ["x"]})])
def test_a_policy_that_cannot_be_used_denies_everything(tmp_path, content):
    file = tmp_path / "policy.json"
    file.write_text(content, encoding="utf-8")
    event = {"tool_name": "todo_write", "tool_input": {}, "cwd": str(tmp_path)}
    assert "guard failed" in decision(run_script("head-guard.py", "--policy", file, stdin=json.dumps(event)))


def test_a_missing_policy_denies_everything(tmp_path):
    event = {"tool_name": "todo_write", "tool_input": {}, "cwd": str(tmp_path)}
    assert "guard failed" in decision(run_script("head-guard.py", "--policy", tmp_path / "none.json", stdin=json.dumps(event)))


def test_malformed_stdin_denies(policy):
    assert "guard failed" in decision(run_script("head-guard.py", "--policy", policy["file"], stdin="not json"))
