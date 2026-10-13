#!/usr/bin/env python3
"""
@author Shakib
@since 08/10/26

PreToolUse hook (Command Code and CodeBuddy) for Hydra's Heads: denies a write or edit whose real path is outside the project
and the folders the Heads may also write to.
Usage: head-guard.py <project root> [<write dir> ...], with the hook's JSON on stdin.
"""
import json
import os
import sys

WRITE_TOOLS = {"write_file", "edit_file", "Write", "Edit", "MultiEdit", "NotebookEdit"}
WRITE_NAMES = {"WRITE", "EDIT"}


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"{reason} Do not retry it: Heads write only inside the project and the folders the Lead granted.",
    }}))


def is_inside(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def main():
    roots = [os.path.realpath(root) for root in sys.argv[1:]]
    root = roots[0]
    event = json.load(sys.stdin)
    if event.get("tool_name") not in WRITE_TOOLS and event.get("tool_display_name") not in WRITE_NAMES:
        return
    tool_input = event.get("tool_input") or {}
    raw = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path")
    if not isinstance(raw, str) or not raw.strip():
        deny("Hydra could not tell which file this call writes.")
        return
    path = os.path.realpath(os.path.join(event.get("cwd") or root, os.path.expanduser(raw)))
    if not any(is_inside(path, allowed) for allowed in roots):
        deny(f"Hydra: {raw} is outside the project.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # A guard that cannot decide denies: the engine runs the tool when a hook fails.
        deny(f"Hydra's write guard failed ({error}).")
