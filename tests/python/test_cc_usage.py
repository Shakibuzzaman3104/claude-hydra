"""
@author Shakib
@since 15/10/26
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from conftest import load_script, run_script, write_jsonl

NOW = datetime.now(timezone.utc)


def stamp(ago):
    """An ISO time the way Command Code writes it: UTC, milliseconds, a trailing Z."""
    return (NOW - ago).strftime("%Y-%m-%dT%H:%M:%S.") + f"{(NOW - ago).microsecond // 1000:03d}Z"


def spend(ago, cost):
    return {"timestamp": stamp(ago), "usage": {"costUsd": cost}}


@pytest.fixture
def home(tmp_path):
    return tmp_path / "home"


@pytest.fixture
def projects(home):
    folder = home / ".commandcode" / "projects"
    folder.mkdir(parents=True)
    return folder


def usage(home, *args):
    """Runs cc-usage.py with HOME (POSIX) and USERPROFILE (Windows) pointing at the fake home."""
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    env.pop("HOMEDRIVE", None)
    env.pop("HOMEPATH", None)
    result = run_script("cc-usage.py", *args, env=env)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_the_rolling_windows_sum_spend_inside_each_span(home, projects):
    write_jsonl(projects / "p" / "s1.jsonl", [
        spend(timedelta(hours=1), 0.5),
        spend(timedelta(hours=6), 0.25),  # in the week, out of the 5 hours
        spend(timedelta(days=8), 1.0),  # out of both
        {"timestamp": stamp(timedelta(minutes=5)), "message": {"content": "no usage on this row"}},
        {"timestamp": "not a time", "usage": {"costUsd": 9.0}},
        {"timestamp": stamp(timedelta(minutes=5)), "usage": {"costUsd": "free"}},
    ])
    write_jsonl(projects / "q" / "s2.jsonl", [spend(timedelta(minutes=30), 0.125)])
    write_jsonl(projects / "q" / "s2.checkpoints.jsonl", [spend(timedelta(minutes=1), 100.0)])  # checkpoints are not spend
    (projects / "q" / "notes.txt").write_text('"costUsd": 50', encoding="utf-8")
    (projects / "stray-file").write_text("", encoding="utf-8")

    report = usage(home)

    assert report["fiveHour"]["usd"] == 0.625
    assert report["weekly"]["usd"] == 0.875
    assert isinstance(report["measuredAt"], int)
    oldest_five = NOW - timedelta(hours=1)
    oldest_week = NOW - timedelta(hours=6)
    assert abs(datetime.fromisoformat(report["fiveHour"]["resetsAt"]) - (oldest_five + timedelta(hours=5))) < timedelta(seconds=1)
    assert abs(datetime.fromisoformat(report["weekly"]["resetsAt"]) - (oldest_week + timedelta(days=7))) < timedelta(seconds=1)


def test_an_empty_window_is_zero_with_no_reset(home, projects):
    write_jsonl(projects / "p" / "s1.jsonl", [spend(timedelta(days=9), 3.0)])
    report = usage(home)
    assert report["fiveHour"] == {"usd": 0.0, "resetsAt": None}
    assert report["weekly"] == {"usd": 0.0, "resetsAt": None}


def test_without_a_projects_folder_it_reports_an_error(home):
    home.mkdir()
    assert usage(home) == {"error": "~/.commandcode/projects not found"}


def test_session_sums_that_sessions_cost(home, projects):
    write_jsonl(projects / "p" / "abc.jsonl", [spend(timedelta(days=30), 0.25), spend(timedelta(hours=1), 0.5), {"message": "no cost"}])
    write_jsonl(projects / "p" / "other.jsonl", [spend(timedelta(hours=1), 7.0)])
    assert usage(home, "--session", "abc") == {"usd": 0.75}
    assert usage(home, "--session", "missing") == {"usd": None}


def tool_use(call_id, name, **tool_input):
    return {"message": {"content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]}}


def tool_result(call_id, text, cost=None):
    row = {"message": {"content": [{"type": "tool_result", "tool_use_id": call_id, "content": text}]}}
    if cost is not None:
        row["usage"] = {"costUsd": cost}
    return row


def test_report_lists_edited_files_denials_calls_and_cost(home, projects):
    write_jsonl(projects / "p" / "sess.jsonl", [
        {"timestamp": stamp(timedelta(minutes=9)), "usage": {"costUsd": 0.1}, "message": {"content": "thinking"}},
        tool_use("t1", "edit_file", file_path="/proj/a.py"),
        tool_result("t1", "Edited /proj/a.py", cost=0.2),
        tool_use("t2", "write_file", file_path="/proj/failed.py"),
        tool_result("t2", "Error: could not write"),
        tool_use("t3", "edit_file", file_path="/proj/.env"),
        tool_result("t3", [{"type": "text", "text": "Blocked by permission deny rule: Edit(.env)"}]),
        tool_use("t4", "shell", command="rm -rf /"),
        tool_result("t4", "Permission denied by hook policy"),
        tool_use("t5", "edit_file", file_path="/proj/a.py"),  # the same file twice is listed once
        tool_result("t5", "Edited /proj/a.py", cost=0.05),
        tool_use("t6", "read_file", path="/proj/readme.md"),
        tool_result("t6", "# readme"),
    ])
    with open(projects / "p" / "sess.jsonl", "a", encoding="utf-8") as transcript:
        transcript.write("this line is not json\n")

    report = usage(home, "--report", "sess")

    assert set(report) == {"usd", "files", "denied", "toolCalls"}
    assert report["usd"] == 0.35
    assert report["toolCalls"] == 6
    assert report["files"] == ["/proj/a.py"]
    assert report["denied"] == [
        {"tool": "edit_file", "target": "/proj/.env", "text": "Blocked by permission deny rule: Edit(.env)"},
        {"tool": "shell", "target": "rm -rf /", "text": "Permission denied by hook policy"},
    ]


def test_report_keeps_only_the_last_twelve_denials(home, projects):
    rows = []
    for number in range(15):
        rows += [tool_use(f"d{number}", "shell", command=f"cmd{number}"), tool_result(f"d{number}", "Blocked by permission deny rule")]
    write_jsonl(projects / "p" / "many.jsonl", rows)
    denied = usage(home, "--report", "many")["denied"]
    assert [item["target"] for item in denied] == [f"cmd{number}" for number in range(3, 15)]


def test_report_of_an_unknown_session_is_empty(home, projects):
    assert usage(home, "--report", "nope") == {"usd": None, "files": [], "denied": [], "toolCalls": 0}


def test_find_returns_the_first_session_started_after_the_time_with_that_prompt(home, projects):
    created = NOW - timedelta(minutes=10)
    since_ms = int((NOW - timedelta(minutes=20)).timestamp() * 1000)
    write_jsonl(projects / "p" / "late.checkpoints.jsonl", [{"createdAt": stamp(timedelta(minutes=2)), "prompt": "Fix the bug in parser"}])
    write_jsonl(projects / "p" / "early.checkpoints.jsonl", [{"createdAt": created.isoformat(), "prompt": "Fix the bug in parser, please"}])
    write_jsonl(projects / "p" / "unrelated.checkpoints.jsonl", [{"createdAt": stamp(timedelta(minutes=9)), "prompt": "Something else"}])
    write_jsonl(projects / "p" / "before.checkpoints.jsonl", [{"createdAt": stamp(timedelta(hours=2)), "prompt": "Fix the bug in parser"}])
    assert usage(home, "--find", since_ms, "Fix the bug in parser") == {"sessionId": "early"}
    assert usage(home, "--find", since_ms, "No such prompt") == {"sessionId": None}


@pytest.mark.parametrize("raw", ["2026-10-12T10:00:00Z", "2026-10-12T10:00:00.5Z", "2026-10-12T10:00:00.123456789Z", "2026-10-12T10:00:00+00:00"])
def test_parse_time_accepts_the_shapes_javascript_and_python_write(raw):
    parsed = load_script("cc-usage.py").parse_time(raw)
    assert parsed is not None and parsed.utcoffset() == timedelta(0)


@pytest.mark.parametrize("raw", [None, "", "yesterday", 5])
def test_parse_time_rejects_garbage(raw):
    assert load_script("cc-usage.py").parse_time(raw) is None
