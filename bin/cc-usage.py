#!/usr/bin/env python3
"""
@author Shakib
@since 06/10/26

Sums Command Code spend (usage.costUsd) from ~/.commandcode/projects over rolling 5h and 7d windows,
for one session with --session <id>, or reports one session's cost, edited files and denied calls with --report <id>.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.expanduser("~/.commandcode/projects")
FIVE_HOURS = timedelta(hours=5)
WEEK = timedelta(days=7)


def parse_time(raw):
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def spend_entries(since):
    cutoff = since.timestamp()
    for project in os.scandir(ROOT):
        if not project.is_dir():
            continue
        for entry in os.scandir(project.path):
            name = entry.name
            if not name.endswith(".jsonl") or name.endswith(".checkpoints.jsonl"):
                continue
            if entry.stat().st_mtime < cutoff:
                continue
            with open(entry.path, encoding="utf-8", errors="replace") as transcript:
                for line in transcript:
                    if '"costUsd"' not in line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    stamp = parse_time(row.get("timestamp"))
                    cost = (row.get("usage") or {}).get("costUsd")
                    if stamp and isinstance(cost, (int, float)) and stamp >= since:
                        yield stamp, float(cost)


def window(entries, now, span):
    inside = [(t, c) for t, c in entries if t >= now - span]
    if not inside:
        return {"usd": 0.0, "resetsAt": None}
    oldest = min(t for t, _ in inside)
    return {"usd": round(sum(c for _, c in inside), 4), "resetsAt": (oldest + span).isoformat()}


def session_cost(session_id):
    for project in os.scandir(ROOT):
        path = os.path.join(project.path, session_id + ".jsonl")
        if not os.path.exists(path):
            continue
        total = 0.0
        with open(path, encoding="utf-8", errors="replace") as transcript:
            for line in transcript:
                if '"costUsd"' in line:
                    try:
                        total += float((json.loads(line).get("usage") or {}).get("costUsd") or 0)
                    except ValueError:
                        pass
        return round(total, 4)
    return None


EDIT_TOOLS = {"edit_file", "write_file", "multi_edit", "notebook_edit"}
DENIAL_MARKS = ("permission denied", "requires permissions", "denied by", "not allowed")


def transcript_path(session_id):
    for project in os.scandir(ROOT):
        path = os.path.join(project.path, session_id + ".jsonl")
        if os.path.exists(path):
            return path
    return None


def tool_target(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for key in ("file_path", "path", "command", "pattern", "url"):
        if tool_input.get(key):
            return str(tool_input[key])[:160]
    return ""


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def session_report(session_id):
    path = transcript_path(session_id)
    if not path:
        return {"usd": None, "files": [], "denied": [], "toolCalls": 0}
    calls, files, denied, usd, count = {}, [], [], 0.0, 0
    with open(path, encoding="utf-8", errors="replace") as transcript:
        for line in transcript:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            usd += float((row.get("usage") or {}).get("costUsd") or 0)
            content = (row.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    count += 1
                    calls[block.get("id")] = (block.get("name", ""), tool_target(block.get("input")))
                elif block.get("type") == "tool_result":
                    name, target = calls.get(block.get("tool_use_id"), ("", ""))
                    text = result_text(block.get("content"))
                    if any(mark in text.lower() for mark in DENIAL_MARKS):
                        denied.append({"tool": name, "target": target, "text": text[:200]})
                    elif name in EDIT_TOOLS and not text.lower().startswith("error") and target and target not in files:
                        files.append(target)
    return {"usd": round(usd, 4), "files": files, "denied": denied[-12:], "toolCalls": count}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--report":
        print(json.dumps(session_report(sys.argv[2])))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--session":
        print(json.dumps({"usd": session_cost(sys.argv[2])}))
        return
    now = datetime.now(timezone.utc)
    if not os.path.isdir(ROOT):
        print(json.dumps({"error": "~/.commandcode/projects not found"}))
        return
    entries = list(spend_entries(now - WEEK))
    print(json.dumps({
        "fiveHour": window(entries, now, FIVE_HOURS),
        "weekly": window(entries, now, WEEK),
        "measuredAt": int(time.time() * 1000),
    }))


if __name__ == "__main__":
    sys.exit(main())
